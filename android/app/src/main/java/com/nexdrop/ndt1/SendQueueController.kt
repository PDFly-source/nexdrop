package com.nexdrop.ndt1

/**
 * v1.5 Phase D — SEND QUEUE CONTROLLER.
 *
 * Owns the ordered send queue and its per-file state machine, the truthful
 * byte-based aggregate progress, retry/cancel/pause orchestration, duplicate
 * protection and failure isolation. It sits ABOVE the NDT1 engine: it never
 * touches sockets, frames, or TurboSender itself — the Host (MainActivity)
 * bridges to the real engine. Pure Kotlin (no Android imports) so the whole
 * orchestration layer is JVM-unit-testable.
 *
 * Threading contract: all mutations happen on the MAIN thread (the engine's
 * listener callbacks arrive on the sender thread and are marshaled by the
 * Host before they reach the controller). Cross-thread readers only touch
 * the @Volatile item fields (progress ticks).
 *
 * Continuity with Phase B/C: items stay URI + metadata references (never
 * bytes); previews remain owned by PreviewProvider and its bounded cache —
 * the controller knows nothing about bitmaps.
 */
class SendQueueController(
  private val host: Host,
  private val maxAutoRetries: Int = 3,
) {

  /** Engine + UI bridge implemented by MainActivity. */
  interface Host {
    /** Start the real sequential transfer for this item (TurboSender + FGS). */
    fun startTransfer(item: QueueItem)
    /** Stop the in-flight transfer (engine cancel). */
    fun cancelActiveTransfer()
    /** Pause/resume the in-flight transfer (engine control). */
    fun pauseActive(pause: Boolean)
    /** Run [action] on the main thread after [delayMs]. */
    fun schedule(delayMs: Long, action: () -> Unit)
    /** Queue state changed — host may re-render (its own throttling applies). */
    fun onQueueChanged()
    /** Queue drained (success or with failures) — host shows the RESULT screen. */
    fun onQueueFinished(summary: Summary)
  }

  /**
   * Per-file queue state. Only observable states exist — there is no
   * synthetic PREPARING/WAITING_FOR_DEVICE because TurboSender exposes
   * exactly onProgress/onComplete/onError (v1.4 engine, frozen), so nothing
   * between "send started" and "first progress tick" can be observed. It
   * is shown as TRANSFERRING, honestly. SKIPPED exists only as an ADD-time
   * outcome (duplicates are refused entry and reported in AddResult) —
   * a skipped file is never a queue row.
   */
  enum class QState { QUEUED, TRANSFERRING, PAUSED, RETRYING, COMPLETED, FAILED, CANCELLED }

  /** URI + metadata reference only — never file bytes, never bitmaps. */
  class QueueItem(
    val uri: String,
    val name: String,
    val size: Long,
    val kind: FileKind,
    val mime: String?,
    val lastModified: Long,
  ) {
    val stableId: String = "$uri|$name|$size"
    @Volatile var state = QState.QUEUED
    /** Real durable bytes transferred (engine-reported; never fabricated). */
    @Volatile var transferred = 0L
    @Volatile var error: String? = null
    /** Automatic retries used (connection drops that can resume). */
    var retryCount = 0
    val isBusy: Boolean get() = state == QState.TRANSFERRING || state == QState.RETRYING || state == QState.PAUSED
  }

  /** Honest add outcome for a batch — never claims more than was added. */
  data class AddResult(val added: Int, val skipped: Int) {
    val total: Int get() = added + skipped
  }

  /** Queue-drain result — the RESULT screen renders from real counts only. */
  data class Summary(
    val completed: Int,
    val failed: Int,
    val completedBytes: Long,
    val sessionDurationMs: Long,
  )

  val items = ArrayList<QueueItem>()

  /** The one in-flight item (strictly sequential — at most one, by design). */
  var current: QueueItem? = null
    private set

  private var queuePaused = false
  private var finished = true
  private var sessionStartNanos = 0L
  /** Connection-drop retry armed but deferred by a queue pause. */
  private var pendingRetry: QueueItem? = null

  // -------------------------------------------------- add / dedup ----

  /**
   * Duplicate protection (Phase B semantics kept): the same URI is never
   * silently added twice. Returns an honest AddResult so the UI can say
   * "Added 8 of 10 — 2 duplicates skipped".
   */
  @Synchronized
  fun add(item: QueueItem): AddResult {
    if (items.any { it.stableId == item.stableId }) return AddResult(0, 1)
    items.add(item)
    finished = false
    host.onQueueChanged()
    return AddResult(1, 0)
  }

  @Synchronized
  fun addBatch(list: List<QueueItem>): AddResult {
    var added = 0; var skipped = 0
    for (item in list) {
      if (items.any { it.stableId == item.stableId }) { skipped++; continue }
      items.add(item); added++
    }
    if (added > 0) { finished = false; host.onQueueChanged() }
    return AddResult(added, skipped)
  }

  // ------------------------------------------------------ ordering ----

  /** Reorder guard: a busy (transferring/paused/retrying) item never moves. */
  @Synchronized
  fun move(item: QueueItem, up: Boolean): Boolean {
    val i = items.indexOf(item)
    if (i < 0 || item.isBusy) return false
    val j = if (up) i - 1 else i + 1
    if (j < 0 || j >= items.size) return false
    items.removeAt(i); items.add(j, item)
    host.onQueueChanged()
    return true
  }

  /**
   * Remove rules (§11): QUEUED/FAILED/CANCELLED/COMPLETED remove
   * immediately; a TRANSFERRING/PAUSED/RETRYING item is REFUSED — the
   * user must cancel the transfer first, never an orphaned sender.
   */
  @Synchronized
  fun remove(item: QueueItem): Boolean {
    if (item.isBusy) return false
    val ok = items.remove(item)
    if (ok) host.onQueueChanged()
    return ok
  }

  /** Clear completed rows. Never touches history or user files. */
  @Synchronized
  fun clearCompleted(): Int = removeAllMatching { it.state == QState.COMPLETED }

  /** Clear failed and cancelled rows. */
  @Synchronized
  fun clearFailed(): Int = removeAllMatching { it.state == QState.FAILED || it.state == QState.CANCELLED }

  /** Clear the whole queue (busy items are excluded — cancel them first). */
  @Synchronized
  fun clearAll(): Int = removeAllMatching { !it.isBusy }

  private fun removeAllMatching(matching: (QueueItem) -> Boolean): Int {
    val before = items.size
    items.removeAll { matching(it) && !it.isBusy }
    val n = before - items.size
    if (n > 0) host.onQueueChanged()
    return n
  }

  // ----------------------------------------------------- lifecycle ----

  /**
   * Begin (or resume) the sequential drain. No-op while a transfer is
   * in flight (strictly one file at a time) or while the queue is paused.
   */
  fun start() {
    if (current != null || queuePaused) return
    if (items.isEmpty()) return
    if (sessionStartNanos == 0L) sessionStartNanos = System.nanoTime()
    next()
  }

  /** True when at least one QUEUED item remains. */
  fun hasQueued(): Boolean = items.any { it.state == QState.QUEUED }

  private fun next() {
    val item = items.firstOrNull { it.state == QState.QUEUED } ?: return drain()
    item.state = QState.TRANSFERRING
    item.transferred = 0L
    current = item
    host.startTransfer(item)
    host.onQueueChanged()
  }

  /** Queue drained — only real states count toward the summary. */
  private fun drain() {
    current = null
    sessionStartNanos = 0L
    finished = true
    val done = items.filter { it.state == QState.COMPLETED }
    host.onQueueFinished(Summary(
      completed = done.size,
      failed = items.count { it.state == QState.FAILED },
      completedBytes = done.sumOf { it.size },
      sessionDurationMs = 0L, // host composes the real wall duration it measured
    ))
  }

  // --------------------------------------------- transfer callbacks ----

  /** Engine progress tick (durable bytes). Volatile write, no allocation. */
  fun onTransferProgress(durable: Long) {
    current?.transferred = durable
  }

  /** Engine-reported verified completion — the only path to COMPLETED. */
  fun onTransferCompleted(item: QueueItem) {
    item.state = QState.COMPLETED
    item.transferred = item.size
    item.error = null
    if (current === item) current = null
    if (queuePaused) { host.onQueueChanged(); return }
    next()
  }

  /** Engine pause/resume of the in-flight file (real engine control). */
  fun onTransferPaused(paused: Boolean) {
    val c = current ?: return
    if (paused && c.state == QState.TRANSFERRING) c.state = QState.PAUSED
    else if (!paused && c.state == QState.PAUSED) c.state = QState.TRANSFERRING
    host.onQueueChanged()
  }

  /**
   * Transfer failure. With a resumable connection drop (receiver holds the
   * .ndtpart, session can still authorize) the EXISTING durable-offset
   * resume semantics apply: bounded automatic RETRYING (default 3, backoff
   * 1s/2s/4s), never from zero. Budget exhausted or a hard error → FAILED
   * with the honest message — and FAILURE ISOLATION: the queue continues
   * with the next QUEUED file instead of dying.
   */
  fun onTransferError(item: QueueItem, message: String, canAutoResume: Boolean) {
    val resumable = canAutoResume && item.retryCount < maxAutoRetries && item.state != QState.CANCELLED
    if (resumable) {
      item.retryCount++
      item.state = QState.RETRYING
      item.error = message
      pendingRetry = item
      val wait = minOf(1000L shl (item.retryCount - 1), 4000L)
      host.schedule(wait) { firePendingRetry(item) }
      host.onQueueChanged()
      return
    }
    failCurrent(item, message)
  }

  private fun failCurrent(item: QueueItem, message: String) {
    item.state = QState.FAILED
    item.error = message
    if (pendingRetry === item) pendingRetry = null
    if (current === item) current = null
    host.onQueueChanged()
    if (queuePaused) return
    next() // failure isolation — the next QUEUED file proceeds
  }

  // ------------------------------------------------- retry (manual) ----

  /** Manual retry of a FAILED file: re-arm it as QUEUED. */
  fun retry(item: QueueItem): Boolean {
    if (item.state != QState.FAILED || item.isBusy) return false
    item.state = QState.QUEUED
    item.error = null
    item.retryCount = 0
    item.transferred = 0L
    finished = false
    host.onQueueChanged()
    start()
    return true
  }

  /** Retry every FAILED file (RESULT screen action). */
  fun retryFailed(): Int {
    var n = 0
    items.filter { it.state == QState.FAILED }.forEach {
      it.state = QState.QUEUED; it.error = null; it.retryCount = 0; it.transferred = 0L; n++
    }
    if (n > 0) { finished = false; host.onQueueChanged() }
    start()
    return n
  }

  // --------------------------------------------- pause / cancel ops ----

  /**
   * The armed connection-drop retry fires: same pairing + session → the
   * receiver answers READY(durableOffset) — never from zero. If the queue
   * was paused in the meantime, the retry stays deferred (no polling: it
   * fires once on resume). If the item was cancelled/failed meanwhile,
   * this is a harmless no-op.
   */
  private fun firePendingRetry(item: QueueItem) {
    if (item.state != QState.RETRYING || current !== item) return
    if (queuePaused) return // stay deferred; resumeQueue re-fires it
    pendingRetry = null
    item.state = QState.TRANSFERRING
    host.startTransfer(item)
  }

  /**
   * Queue-level pause: an in-flight transfer uses the real engine pause
   * (connection kept alive); a RETRYING item simply stops reconnecting.
   * After the current file completes, the next file does NOT start until
   * resume(). Never a fake pause (§14).
   */
  fun pauseQueue() {
    queuePaused = true
    val c = current
    if (c != null && c.state == QState.TRANSFERRING) {
      host.pauseActive(true)
      c.state = QState.PAUSED
    }
    host.onQueueChanged()
  }

  fun resumeQueue() {
    queuePaused = false
    val c = current
    when {
      c != null && c.state == QState.PAUSED && pendingRetry === c -> {
        // paused in the retry window → reconnect (durable resume), no engine to unpause
        pendingRetry = null
        c.state = QState.TRANSFERRING
        host.startTransfer(c)
      }
      c != null && c.state == QState.PAUSED -> {
        c.state = QState.TRANSFERRING
        host.pauseActive(false)
      }
      else -> pendingRetry?.let { firePendingRetry(it) }
    }
    host.onQueueChanged()
    if (current == null) start() // was idle between files → continue the drain
  }

  val isPaused: Boolean get() = queuePaused

  /** Cancel only the in-flight file (engine stop); QUEUED items stay queued. */
  fun cancelCurrentTransfer() {
    val c = current
    if (c != null) {
      host.cancelActiveTransfer()
      c.state = QState.CANCELLED
      current = null
      pendingRetry = null
      host.onQueueChanged()
    }
  }

  /**
   * CANCEL ALL (§15): stop the in-flight transfer, mark it and every
   * remaining unfinished item CANCELLED. Completed items and history are
   * never modified; user files are never deleted.
   */
  fun cancelAll() {
    if (current != null) host.cancelActiveTransfer()
    items.forEach { if (it.state != QState.COMPLETED) it.state = QState.CANCELLED }
    current = null
    pendingRetry = null
    queuePaused = false
    host.onQueueChanged()
  }

  // --------------------------------------------------------- totals ----

  /** 1-based position of the in-flight file within the queue. */
  val currentPosition: Int get() = current?.let { items.indexOf(it) + 1 } ?: 0

  val totalItems: Int get() = items.size
  val totalBytes: Long get() = items.sumOf { it.size }

  val completedCount: Int get() = items.count { it.state == QState.COMPLETED }
  val failedCount: Int get() = items.count { it.state == QState.FAILED }
  val cancelledCount: Int get() = items.count { it.state == QState.CANCELLED }
  val remainingCount: Int get() = items.count { it.state == QState.QUEUED || it.isBusy }

  /** Bytes of files the engine verified complete. */
  val completedBytes: Long get() = items.filter { it.state == QState.COMPLETED }.sumOf { it.size }

  /**
   * Truthful aggregate (§7): completed bytes + the real durable bytes of
   * the in-flight file — over total queue bytes. Never an average of
   * percentages, never an estimate.
   */
  val overallBytes: Long get() = completedBytes + (current?.transferred ?: 0L)
  fun overallFraction(): Double {
    val t = totalBytes
    return if (t > 0) overallBytes.toDouble() / t else 0.0
  }
}
