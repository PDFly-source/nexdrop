package com.nexdrop.ndt1.ui

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.view.View

/**
 * Live transfer speed graph (v1.4 Phase 4). Fed ONLY by real measured
 * samples from the engine's onProgress callbacks (instantaneous bytes
 * over elapsed time — the same math as SpeedFormat). No synthetic data,
 * no smoothing, no fake peaks: what is drawn is exactly what was sampled.
 * The caller throttles add() to a few Hz so the graph never competes with
 * the NDT1 transfer thread for UI time.
 */
class SpeedGraphView(context: Context) : View(context) {

  private val samples = ArrayList<Float>()   // bytes/sec, real measured
  private var maxSamples = 72               // ~ last 72 ticks (caller-paced)
  private val paintLine = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.STROKE
    strokeWidth = context.dp(2).toFloat()
    strokeCap = Paint.Cap.ROUND
    strokeJoin = Paint.Join.ROUND
    color = D.PRIMARY
  }
  private val paintFill = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.FILL
    color = D.argb(31, D.PRIMARY)
  }
  private val paintGrid = Paint().apply {
    style = Paint.Style.STROKE
    strokeWidth = 1f
    color = D.argb(26, D.MUTED)
  }
  private val paintText = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = D.MUTED
    textSize = context.dp(9).toFloat()
    isFakeBoldText = false
  }

  /** One real sample (bytes/sec). Pruned to maxSamples; invalidates. */
  fun add(bps: Double) {
    samples.add(bps.toFloat())
    while (samples.size > maxSamples) samples.removeAt(0)
    contentDescription = "Speed graph: ${UiSpeed.speedText(bps)} latest of ${samples.size} samples"
    invalidate()
  }

  fun peakBps(): Double = samples.maxOrNull()?.toDouble() ?: 0.0

  override fun onDraw(c: Canvas) {
    super.onDraw(c)
    val w = width.toFloat(); val h = height.toFloat()
    if (w <= 0 || h <= 0) return
    // baseline grid: 3 hairlines, honest axes
    for (i in 1..3) {
      val y = h * i / 4f
      c.drawLine(0f, y, w, y, paintGrid)
    }
    if (samples.size < 2) return
    val max = maxOf(samples.max(), 1_000_000f) // never zero-scale
    val stepX = w / (maxSamples - 1).coerceAtLeast(1).toFloat()
    val startIdx = maxSamples - samples.size
    val path = Path()
    val fill = Path()
    samples.forEachIndexed { i, v ->
      val x = (startIdx + i) * stepX
      val y = h - (v / max).coerceIn(0f, 1f) * h
      if (i == 0) { path.moveTo(x, y); fill.moveTo(x, h); fill.lineTo(x, y) }
      else { path.lineTo(x, y); fill.lineTo(x, y) }
    }
    fill.lineTo(w, h); fill.close()
    c.drawPath(fill, paintFill)
    c.drawPath(path, paintLine)
    // honest max label — the CURRENT graph scale, real sample maximum
    c.drawText(UiSpeed.speedText(max.toDouble()), context.dp(2).toFloat(), context.dp(10).toFloat(), paintText)
  }
}
