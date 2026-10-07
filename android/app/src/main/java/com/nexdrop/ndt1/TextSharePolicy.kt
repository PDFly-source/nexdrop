package com.nexdrop.ndt1

/**
 * v1.5 Phase F — LIVE TEXT policy (pure Kotlin, JVM-tested).
 *
 * Text sharing travels through the EXISTING authenticated NDT1 direct
 * session as a real small .txt file on the queue — one protocol, one
 * queue controller, no cloud, no second channel. This object owns only
 * the honest bounds and the bounded preview rules:
 *
 *  - a shareable text is a real on-disk .txt within MAX_TEXT_BYTES
 *  - nothing larger may enter the text flow (honest rejection, no silent
 *    truncation of content the user believes was sent whole)
 *  - previews shown on screen are bounded and say so when clipped
 *  - the clipboard is touched ONLY on an explicit user Copy action
 */
object TextSharePolicy {
  /** Safe bounded limit for the text flow (256 KiB — clipboard-sized). */
  const val MAX_TEXT_BYTES: Int = 256 * 1024

  /** Detection: a real .txt file within the bound. Nothing invented. */
  fun isShareableText(name: String, sizeBytes: Long): Boolean =
    name.endsWith(".txt", ignoreCase = true) && sizeBytes in 1..MAX_TEXT_BYTES.toLong()

  /** Honest rejection for the sender dialog — never silent truncation. */
  fun tooLarge(sizeBytes: Int): Boolean = sizeBytes > MAX_TEXT_BYTES

  /**
   * Bounded on-screen preview. Returns the (possibly clipped) text and
   * an honest suffix when content was omitted — the user always knows
   * they are seeing a preview, and how much.
   */
  fun preview(text: String, maxChars: Int = 600): String {
    if (text.length <= maxChars) return text
    val omitted = text.length - maxChars
    return text.take(maxChars) + "…\n\n[${SpeedFormat.bytesText(text.toByteArray().size.toLong())} total · ${omitted} more characters not shown]"
  }
}
