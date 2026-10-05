package com.nexdrop.ndt1.ui

import android.animation.ValueAnimator
import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ColorFilter
import android.graphics.DashPathEffect
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RadialGradient
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.SweepGradient
import android.view.animation.LinearInterpolator
import android.graphics.Typeface
import android.graphics.drawable.Drawable
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.content.res.ResourcesCompat
import com.nexdrop.ndt1.R

/**
 * NexDrop design system — a 1:1 port of the single source of truth
 * ("NexDrop — Android App Mockup.html"). Every color, radius, gradient,
 * font, size and shadow below is taken from the mockup's CSS, not
 * reinterpreted as Material. No Material components are used; the UI is
 * programmatic so the engine (ndt1) stays untouched.
 *
 * Mockup tokens (CSS variables):
 *   --bg #070A10  --s #101722  --e #151E2B  --p #18D6C5  --b #4C8DFF
 *   --ok #35D07F  --t #F5F7FA  --m #9AA6B2  --ln rgba(255,255,255,.08)
 *   fonts: Sora (display, 500/600/700) + Manrope (body, 400-700)
 */
/**
 * Design tokens. Theme-aware (v1.4 Phase 6): the values are MUTABLE so a
 * theme switch re-skins the whole programmatic UI on the next render —
 * every view reads tokens at build/draw time, nothing is baked in.
 * DARK is the shipped NexDrop look (unchanged); LIGHT is a proper high-
 * contrast inverse — no white-on-white, no dark-on-dark.
 */
object D {
  var BG = 0xFF070A10.toInt()
  var SURFACE = 0xFF101722.toInt()
  var ELEVATED = 0xFF151E2B.toInt()
  var PRIMARY = 0xFF18D6C5.toInt()
  var PRIMARY_LIGHT = 0xFF34F0DE.toInt()
  var BLUE = 0xFF4C8DFF.toInt()
  var BLUE_LIGHT = 0xFF3F86F7.toInt()
  var OK = 0xFF35D07F.toInt()
  var TEXT = 0xFFF5F7FA.toInt()
  var MUTED = 0xFF9AA6B2.toInt()
  var NAV_IDLE = 0xFF6B7785.toInt()
  var BTN_TEXT = 0xFF021A1A.toInt()
  var DANGER = 0xFFFF7A7A.toInt()
  var AMBER = 0xFFD97706.toInt()
  var RED = 0xFFB91C1C.toInt()
  var QR_DARK = 0xFF0B1220.toInt() // QR modules are ALWAYS dark-on-white
  var LINE = 0x14FFFFFF // rgba(255,255,255,.08) on dark; inverted for light

  var isLight = false

  /** Switch palette. Call before any view is built (render re-skins). */
  fun apply(light: Boolean) {
    isLight = light
    if (!light) {
      BG = 0xFF070A10.toInt(); SURFACE = 0xFF101722.toInt(); ELEVATED = 0xFF151E2B.toInt()
      PRIMARY = 0xFF18D6C5.toInt(); PRIMARY_LIGHT = 0xFF34F0DE.toInt()
      BLUE = 0xFF4C8DFF.toInt(); BLUE_LIGHT = 0xFF3F86F7.toInt()
      OK = 0xFF35D07F.toInt(); TEXT = 0xFFF5F7FA.toInt(); MUTED = 0xFF9AA6B2.toInt()
      NAV_IDLE = 0xFF6B7785.toInt(); BTN_TEXT = 0xFF021A1A.toInt()
      DANGER = 0xFFFF7A7A.toInt(); AMBER = 0xFFD97706.toInt(); RED = 0xFFB91C1C.toInt()
      LINE = 0x14FFFFFF
    } else {
      BG = 0xFFF4F6F8.toInt(); SURFACE = 0xFFFFFFFF.toInt(); ELEVATED = 0xFFEAEEF2.toInt()
      // darker teal/blue/green for WCAG-grade contrast on light surfaces
      PRIMARY = 0xFF0FA394.toInt(); PRIMARY_LIGHT = 0xFF18D6C5.toInt()
      BLUE = 0xFF2E66D9.toInt(); BLUE_LIGHT = 0xFF4C8DFF.toInt()
      OK = 0xFF15803D.toInt(); TEXT = 0xFF0B1220.toInt(); MUTED = 0xFF5B6770.toInt()
      NAV_IDLE = 0xFF8B97A3.toInt(); BTN_TEXT = 0xFF021A1A.toInt()
      DANGER = 0xFFDC2626.toInt(); AMBER = 0xFFB45309.toInt(); RED = 0xFFB91C1C.toInt()
      LINE = 0x14000000
    }
  }

  fun argb(a: Int, rgb: Int): Int = (a shl 24) or (rgb and 0xFFFFFF)
}

fun Context.dp(v: Float): Int = (resources.displayMetrics.density * v).toInt()
fun Context.dp(v: Int): Int = dp(v.toFloat())

/** Sora (display) / Manrope (body) — the mockup's exact Google Fonts. */
object Fonts {
  fun sora(context: Context, weight: Int): Typeface =
    ResourcesCompat.getFont(context, when (weight) {
      500 -> R.font.sora_500; 600 -> R.font.sora_600; else -> R.font.sora_700
    }) ?: Typeface.SANS_SERIF

  fun manrope(context: Context, weight: Int): Typeface =
    ResourcesCompat.getFont(context, when (weight) {
      400 -> R.font.manrope_400; 500 -> R.font.manrope_500
      600 -> R.font.manrope_600; else -> R.font.manrope_700
    }) ?: Typeface.SANS_SERIF
}

/**
 * Glass surface from the mockup. Arbitrary CSS gradient angles
 * (160deg/155deg/145deg/135deg) need a real LinearGradient —
 * GradientDrawable only supports 45-degree multiples — hence a custom
 * Drawable. Supports:
 *   .card    linear-gradient(160deg, rgba(255,255,255,.07), rgba(255,255,255,.015)) + 1px ln border + top highlight
 *   .card.g  linear-gradient(155deg, rgba(24,214,197,.18), rgba(76,141,255,.07) 60%, rgba(255,255,255,.02))
 *   .ic      linear-gradient(145deg, rgba(24,214,197,.16), rgba(76,141,255,.08))
 */
open class GlassDrawable(
  private val radiusPx: Float,
  private val startColor: Int = D.argb(18, Color.WHITE),
  private val midColor: Int? = null,
  private val endColor: Int = D.argb(4, Color.WHITE),
  private val strokeColor: Int = D.LINE,
  private val dashed: Boolean = false,
  private val angleDeg: Float = 160f,
) : Drawable() {

  private val rect = RectF()
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val hl = Path()

  override fun draw(canvas: Canvas) {
    val b = bounds
    if (b.isEmpty) return
    rect.set(b)
    paint.style = Paint.Style.FILL
    paint.pathEffect = null
    val rad = Math.toRadians(angleDeg.toDouble())
    val dx = Math.cos(rad).toFloat()
    val dy = Math.sin(rad).toFloat()
    val len = Math.abs(dx * b.width()) + Math.abs(dy * b.height())
    val x0 = b.width() / 2f - dx * len / 2f
    val y0 = b.height() / 2f - dy * len / 2f
    paint.shader = if (midColor != null)
      LinearGradient(x0, y0, x0 + dx * len, y0 + dy * len,
        intArrayOf(startColor, midColor, endColor), floatArrayOf(0f, 0.60f, 1f), Shader.TileMode.CLAMP)
    else
      LinearGradient(x0, y0, x0 + dx * len, y0 + dy * len, startColor, endColor, Shader.TileMode.CLAMP)
    canvas.drawRoundRect(rect, radiusPx, radiusPx, paint)
    paint.shader = null
    // border: 1px solid (ln, or dashed teal for the drop zone, or a card.g tint)
    paint.style = Paint.Style.STROKE
    paint.strokeWidth = 1f
    if (dashed) paint.pathEffect = DashPathEffect(floatArrayOf(dashUnitPx, dashUnitPx), 0f) else paint.pathEffect = null
    paint.color = strokeColor
    canvas.drawRoundRect(
      RectF(rect.left + 0.5f, rect.top + 0.5f, rect.right - 0.5f, rect.bottom - 0.5f),
      radiusPx, radiusPx, paint)
    // inset 0 1px 0 rgba(255,255,255,.08) — inner top highlight
    paint.pathEffect = null
    paint.color = D.argb(20, Color.WHITE)
    hl.reset()
    hl.moveTo(rect.left + radiusPx, rect.top + 1f)
    hl.lineTo(rect.right - radiusPx, rect.top + 1f)
    canvas.drawPath(hl, paint)
  }

  /** Dash + stroke sized from the calling context's density (set in the factory). */
  var dashUnitPx = 6f * 2.75f

  override fun setAlpha(alpha: Int) {}
  override fun setColorFilter(colorFilter: ColorFilter?) {}
  @Suppress("DEPRECATION", "DEPRECATION")
  override fun getOpacity(): Int = android.graphics.PixelFormat.TRANSLUCENT
  override fun getOutline(outline: android.graphics.Outline) {
    outline.setRoundRect(bounds, radiusPx)
  }
}

/** .btn — linear-gradient(135deg,#34f0de,#18D6C5 45%,#3f86f7), radius 17, glossy top. */
class PrimaryBtnDrawable(private val radiusPx: Float) : Drawable() {
  private val rect = RectF()
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val gloss = Path()
  override fun draw(canvas: Canvas) {
    val b = bounds
    if (b.isEmpty) return
    rect.set(b)
    paint.style = Paint.Style.FILL
    paint.shader = LinearGradient(0f, 0f, b.width().toFloat(), b.height().toFloat(),
      intArrayOf(D.PRIMARY_LIGHT, D.PRIMARY, D.BLUE_LIGHT),
      floatArrayOf(0f, 0.45f, 1f), Shader.TileMode.CLAMP)
    canvas.drawRoundRect(rect, radiusPx, radiusPx, paint)
    paint.shader = null
    paint.style = Paint.Style.STROKE
    paint.strokeWidth = 1.5f
    paint.color = D.argb(128, Color.WHITE)
    val r = radiusPx.coerceAtMost(b.height() / 2f)
    gloss.reset()
    gloss.moveTo(b.left + r, b.top + 1.5f)
    gloss.lineTo(b.right - r, b.top + 1.5f)
    canvas.drawPath(gloss, paint)
  }
  override fun setAlpha(alpha: Int) {}
  override fun setColorFilter(colorFilter: ColorFilter?) {}
  @Suppress("DEPRECATION")
  override fun getOpacity(): Int = android.graphics.PixelFormat.TRANSLUCENT
  override fun getOutline(outline: android.graphics.Outline) { outline.setRoundRect(bounds, radiusPx) }
}

/** Screen background = the mockup's layered radial glows over #070A10. */
class BgView(context: Context) : View(context) {
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
  override fun onDraw(canvas: Canvas) {
    val w = width.toFloat()
    val h = height.toFloat()
    canvas.drawColor(D.BG)
    paint.shader = RadialGradient(w * 0.15f, 0f, w * 0.55f, D.argb(51, D.PRIMARY), D.argb(0, D.PRIMARY), Shader.TileMode.CLAMP)
    canvas.drawRect(0f, 0f, w, h, paint)
    paint.shader = RadialGradient(w * 0.92f, h * 0.08f, w * 0.50f, D.argb(56, D.BLUE), D.argb(0, D.BLUE), Shader.TileMode.CLAMP)
    canvas.drawRect(0f, 0f, w, h, paint)
    paint.shader = RadialGradient(w * 0.5f, h, w * 0.60f, D.argb(31, D.PRIMARY), D.argb(0, D.PRIMARY), Shader.TileMode.CLAMP)
    canvas.drawRect(0f, 0f, w, h, paint)
    paint.shader = RadialGradient(w * 0.5f, -h * 0.08f, w * 1.20f, D.argb(61, D.PRIMARY), D.argb(0, D.PRIMARY), Shader.TileMode.CLAMP)
    canvas.drawRect(0f, 0f, w, h, paint)
    paint.shader = RadialGradient(w * 1.05f, h * 1.05f, w * 0.90f, D.argb(46, D.BLUE), D.argb(0, D.BLUE), Shader.TileMode.CLAMP)
    canvas.drawRect(0f, 0f, w, h, paint)
  }
}

/** .dot — 7px dot with the 2.2s ease-out pulse ring. */
class PulseDotView(context: Context, private val color: Int = D.OK) : View(context) {
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
  private var t = 0f
  private val anim = ValueAnimator.ofFloat(0f, 1f).apply {
    duration = 2200
    repeatCount = ValueAnimator.INFINITE
    interpolator = LinearInterpolator()
    addUpdateListener {
      t = it.animatedValue as Float
      invalidate()
    }
  }
  override fun onAttachedToWindow() { super.onAttachedToWindow(); anim.start() }
  override fun onDetachedFromWindow() { anim.cancel(); super.onDetachedFromWindow() }
  override fun onDraw(canvas: Canvas) {
    val cx = width / 2f
    val cy = height / 2f
    paint.style = Paint.Style.FILL
    paint.color = D.argb(((1f - t) * 128).toInt().coerceIn(0, 128), color)
    canvas.drawCircle(cx, cy, (width / 2f) * (1f + t * 2.3f), paint)
    paint.color = color
    canvas.drawCircle(cx, cy, width / 2f, paint)
  }
}

/** .gt — linear-gradient(120deg,#34f0de,#4C8DFF) applied to Sora text. */
class GradientTextView(context: Context) : androidx.appcompat.widget.AppCompatTextView(context) {
  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    super.onLayout(changed, left, top, right, bottom)
    val w = (right - left).toFloat()
    val h = (bottom - top).toFloat()
    paint.shader = LinearGradient(0f, 0f, w * 0.55f, h, D.PRIMARY_LIGHT, D.BLUE, Shader.TileMode.CLAMP)
    invalidate()
  }
}

/** Mockup progress ring (viewBox 150, r 62, stroke 10, rotate -90). */
class RingView(context: Context) : View(context) {
  private val track = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; color = D.ELEVATED }
  private val arc = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND }
  private val glow = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND }
  private val oval = RectF()
  var progress = 0f
    set(v) { field = v.coerceIn(0f, 1f); invalidate() }

  override fun onDraw(canvas: Canvas) {
    val s = width / 150f
    val stroke = 10f * s
    val r = 62f * s
    val cx = width / 2f
    val cy = height / 2f
    track.strokeWidth = stroke
    arc.strokeWidth = stroke
    glow.strokeWidth = stroke + 3f * s
    arc.shader = SweepGradient(cx, cy, D.PRIMARY, D.BLUE)
    oval.set(cx - r, cy - r, cx + r, cy + r)
    canvas.drawArc(oval, 0f, 360f, false, track)
    glow.color = D.argb(38, D.PRIMARY)
    if (progress > 0.004f) canvas.drawArc(oval, -90f, 360f * progress, false, glow)
    canvas.rotate(-90f, cx, cy)
    if (progress > 0.004f) canvas.drawArc(oval, 0f, 360f * progress, false, arc)
  }
}

/** NexDrop logo (svg symbol "logo", viewBox 48): two devices + relay arc + node. */
class LogoView(context: Context) : View(context) {
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val path = Path()
  override fun onDraw(canvas: Canvas) {
    if (width == 0) return
    val s = width / 48f
    paint.style = Paint.Style.STROKE
    paint.strokeWidth = 3f * s
    paint.strokeCap = Paint.Cap.ROUND
    paint.strokeJoin = Paint.Join.ROUND
    paint.shader = LinearGradient(0f, 0f, width.toFloat(), height.toFloat(), D.PRIMARY, D.BLUE, Shader.TileMode.CLAMP)
    canvas.drawRoundRect(3f * s, 5f * s, 20f * s, 33f * s, 5f * s, 5f * s, paint)
    canvas.drawRoundRect(28f * s, 15f * s, 45f * s, 43f * s, 5f * s, 5f * s, paint)
    path.reset()
    path.moveTo(20f * s, 19f * s)
    path.cubicTo(24f * s, 19f * s, 24f * s, 27f * s, 28f * s, 27f * s)
    canvas.drawPath(path, paint)
    paint.style = Paint.Style.FILL
    paint.shader = null
    paint.color = D.PRIMARY
    canvas.drawCircle(24f * s, 23f * s, 2.6f * s, paint)
  }
}

/** Welcome hero art (svg viewBox 260x90): two devices, dashed link, relay node. */
class HeroView(context: Context) : View(context) {
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val dash = Path()
  override fun onDraw(canvas: Canvas) {
    val s = width / 260f
    val hh = 90f * s
    canvas.save()
    canvas.translate(0f, (height - hh) / 2f)
    paint.style = Paint.Style.STROKE
    paint.strokeWidth = 2f * s
    paint.color = D.argb(89, D.PRIMARY)
    paint.pathEffect = DashPathEffect(floatArrayOf(3f * s, 6f * s), 0f)
    dash.reset(); dash.moveTo(60f * s, 45f * s); dash.lineTo(200f * s, 45f * s)
    canvas.drawPath(dash, paint)
    paint.pathEffect = null
    paint.style = Paint.Style.FILL; paint.color = D.SURFACE
    canvas.drawRoundRect(26f * s, 8f * s, 64f * s, 82f * s, 11f * s, 11f * s, paint)
    paint.style = Paint.Style.STROKE; paint.strokeWidth = 2f * s; paint.color = D.argb(153, D.BLUE)
    canvas.drawRoundRect(26f * s, 8f * s, 64f * s, 82f * s, 11f * s, 11f * s, paint)
    paint.style = Paint.Style.FILL; paint.color = D.SURFACE
    canvas.drawRoundRect(196f * s, 8f * s, 234f * s, 82f * s, 11f * s, 11f * s, paint)
    paint.style = Paint.Style.STROKE; paint.strokeWidth = 2f * s; paint.color = D.argb(178, D.PRIMARY)
    canvas.drawRoundRect(196f * s, 8f * s, 234f * s, 82f * s, 11f * s, 11f * s, paint)
    paint.style = Paint.Style.FILL; paint.color = D.ELEVATED
    canvas.drawCircle(130f * s, 45f * s, 14f * s, paint)
    paint.style = Paint.Style.STROKE; paint.strokeWidth = 1.5f * s; paint.color = D.argb(128, D.PRIMARY)
    canvas.drawCircle(130f * s, 45f * s, 14f * s, paint)
    paint.style = Paint.Style.FILL; paint.color = D.PRIMARY
    canvas.drawCircle(130f * s, 45f * s, 4.5f * s, paint)
    canvas.restore()
  }
}

/** Screen 07 seal: radial green fill, 2px ok border, glow rings + blurred halo. */
class CheckCircleView(context: Context) : View(context) {
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val check = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
  private val path = Path()
  override fun onDraw(canvas: Canvas) {
    val s = width / 84f
    val c = width / 2f
    setLayerType(LAYER_TYPE_SOFTWARE, null)
    paint.style = Paint.Style.FILL
    paint.color = D.argb(18, D.OK)
    canvas.drawCircle(c, c, c - 5f * s, paint)
    paint.color = D.argb(9, D.OK)
    canvas.drawCircle(c, c, c + 1f * s, paint)
    paint.setShadowLayer(22f * s, 0f, 0f, D.argb(89, D.OK))
    paint.shader = RadialGradient(c, c, 42f * s, D.argb(51, D.OK), D.argb(0, D.OK), Shader.TileMode.CLAMP)
    canvas.drawCircle(c, c, 42f * s, paint)
    paint.shader = null
    paint.setShadowLayer(0f, 0f, 0f, 0)
    paint.style = Paint.Style.STROKE
    paint.strokeWidth = 2f * s
    paint.color = D.OK
    canvas.drawCircle(c, c, 42f * s, paint)
    val k = s * (40f / 24f)
    val box = 24f * k
    val ox = c - box / 2f
    val oy = c - box / 2f
    check.strokeWidth = 2.2f * k
    check.strokeCap = Paint.Cap.ROUND
    check.strokeJoin = Paint.Join.ROUND
    check.color = D.OK
    path.reset()
    path.moveTo(ox + 5f * k, oy + 12.5f * k)
    path.lineTo(ox + 9.5f * k, oy + 17f * k)
    path.lineTo(ox + 19f * k, oy + 7.5f * k)
    canvas.drawPath(path, check)
  }
}

/** Screen 06 device link: repeating 6/12 dash (teal .6 left, blue .4 right). */
class DashLineView(context: Context, tint: Int) : View(context) {
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.STROKE
    pathEffect = DashPathEffect(floatArrayOf(6f, 6f), 0f)
    color = tint
  }
  override fun onDraw(canvas: Canvas) {
    paint.strokeWidth = 2f * resources.displayMetrics.density
    canvas.drawLine(0f, height / 2f, width.toFloat(), height / 2f, paint)
  }
}

// ===================== view factories (mockup classes) =====================

/** .card / .card.g container (radius 22, padding 14). */
fun Context.glassCard(
  glow: Boolean = false,
  dashed: Boolean = false,
  strokeColor: Int = D.LINE,
  radius: Float = 22f,
  pad: Float = 14f,
): LinearLayout {
  return LinearLayout(this).apply {
    orientation = LinearLayout.VERTICAL
    val p = dp(pad)
    setPadding(p, p, p, p)
    background = if (glow)
      GlassDrawable(dp(radius).toFloat(),
        startColor = D.argb(46, D.PRIMARY), midColor = D.argb(18, D.BLUE), endColor = D.argb(5, Color.WHITE),
        strokeColor = if (dashed) D.argb(102, D.PRIMARY) else strokeColor, dashed = dashed, angleDeg = 155f)
    else
      GlassDrawable(dp(radius).toFloat(), strokeColor = if (dashed) D.argb(102, D.PRIMARY) else strokeColor,
        dashed = dashed, angleDeg = 160f).apply { dashUnitPx = dp(6).toFloat() * 2f }
    elevation = dp(4).toFloat()
    layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
  }
}

/** .ic — 40px icon box, radius 13, teal gradient + border, tinted icon. */
fun Context.icBox(iconRes: Int, tint: Int = D.PRIMARY, size: Int = 40, filledPrimary: Boolean = false): View {
  val box = LinearLayout(this).apply {
    layoutParams = LinearLayout.LayoutParams(size, size)
    gravity = Gravity.CENTER
    background = GlassDrawable(dp(13).toFloat(),
      startColor = if (filledPrimary) D.PRIMARY else D.argb(41, D.PRIMARY),
      endColor = if (filledPrimary) D.argb(24, D.BLUE_LIGHT) else D.argb(21, D.BLUE),
      strokeColor = if (filledPrimary) D.argb(255, D.PRIMARY) else D.argb(51, D.PRIMARY),
      angleDeg = 145f)
  }
  val iv = ImageView(this).apply {
    setImageResource(iconRes)
    imageTintList = ColorStateList.valueOf(if (filledPrimary) 0xFF04201F.toInt() else tint)
    layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.MATCH_PARENT)
    val pad = dp(10)
    setPadding(pad, pad, pad, pad)
  }
  box.addView(iv)
  return box
}

fun Context.row(height: Int? = null, gravity: Int = Gravity.CENTER_VERTICAL): LinearLayout = LinearLayout(this).apply {
  orientation = LinearLayout.HORIZONTAL
  this.gravity = gravity
  layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT,
    height ?: LinearLayout.LayoutParams.WRAP_CONTENT)
}

fun Context.col(): LinearLayout = LinearLayout(this).apply {
  orientation = LinearLayout.VERTICAL
  layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
}

/** Manrope/Sora text; font=1 → Sora display, else Manrope body. */
fun Context.textView(text: CharSequence, spSize: Float, color: Int, weight: Int = 400, font: Int = 0, letterSpacing: Float? = null): TextView {
  return TextView(this).apply {
    this.text = text
    setTextSize(TypedValue.COMPLEX_UNIT_SP, spSize)
    setTextColor(color)
    typeface = if (font == 1) Fonts.sora(context, weight) else Fonts.manrope(context, weight)
    letterSpacing?.let { this.letterSpacing = it }
    includeFontPadding = false
    layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT)
  }
}

fun Context.h1(text: String, size: Float = 27f) = textView(text, size, D.TEXT, 700, 1, -0.03f)
fun Context.h2(text: String) = textView(text, 22f, D.TEXT, 700, 1, -0.02f)
fun Context.bigText(text: String, size: Float = 34f) = textView(text, size, D.TEXT, 700, 1, -0.04f)
fun Context.sub(text: String) = textView(text, 12.5f, D.MUTED, 500)
fun Context.sm(text: String) = textView(text, 11.5f, D.MUTED, 500)
fun Context.body(text: String) = textView(text, 14f, D.TEXT, 500)

/** .pill — 11.5sp Sora 700 badge, radius 99, tint 10% bg + 25% border. */
fun Context.pill(text: String, tint: Int = D.PRIMARY): TextView {
  return TextView(this).apply {
    this.text = text
    setTextSize(TypedValue.COMPLEX_UNIT_SP, 11.5f)
    setTextColor(tint)
    typeface = Fonts.sora(context, 700)
    letterSpacing = 0.02f
    includeFontPadding = false
    background = android.graphics.drawable.GradientDrawable().apply {
      cornerRadius = dp(99).toFloat()
      setColor(D.argb(26, tint))
      setStroke(dp(1), D.argb(64, tint))
    }
    val h = dp(5); val v = dp(11)
    setPadding(v, h, v, h)
    layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT)
  }
}

/**
 * .btn (primary gradient), .btn.o (outlined glass), .btn.t (teal text).
 * Returns a horizontal row so icon + label match the mockup exactly.
 * Weight is applied when the parent is a row with weights.
 */
fun Context.btn(
  label: String,
  style: String = "primary",
  icon: Int? = null,
  height: Int = 50,
  tintText: Int = D.TEXT,
  weight: Float = 1f,
  onClick: (View) -> Unit,
): View {
  return LinearLayout(this).apply {
    orientation = LinearLayout.HORIZONTAL
    gravity = Gravity.CENTER
    when (style) {
      "primary" -> {
        background = PrimaryBtnDrawable(dp(17).toFloat())
        elevation = dp(6).toFloat()
        if (android.os.Build.VERSION.SDK_INT >= 28) {
          outlineAmbientShadowColor = D.argb(153, D.PRIMARY)
          outlineSpotShadowColor = D.argb(153, D.PRIMARY)
        }
      }
      "outline" -> background = GlassDrawable(dp(17).toFloat())
      else -> {}
    }
    setOnClickListener(onClick)
    layoutParams = LinearLayout.LayoutParams(0, dp(height)).apply { this.weight = weight }
    isClickable = true
    if (icon != null) {
      val iv = ImageView(this@btn).apply {
        setImageResource(icon)
        imageTintList = ColorStateList.valueOf(if (style == "primary") D.BTN_TEXT else tintText)
        layoutParams = LinearLayout.LayoutParams(dp(16), dp(16))
      }
      addView(iv)
      val gap = android.widget.Space(this@btn)
      gap.layoutParams = LinearLayout.LayoutParams(dp(8), 1)
      addView(gap)
    }
    val tv = TextView(this@btn).apply {
      tag = "btnlabel"
      text = label
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 13.5f)
      typeface = Fonts.sora(this@btn, 700)
      letterSpacing = 0.04f
      includeFontPadding = false
      setTextColor(if (style == "primary") D.BTN_TEXT else if (style == "text") D.PRIMARY else tintText)
      gravity = Gravity.CENTER
    }
    addView(tv)
  }
}

/** Bottom nav (.nav): 5 tabs — Home, Transfer, Devices, History, Settings. */
fun Context.bottomNav(active: Int, onSelect: (Int) -> Unit): View {
  val tabs = listOf(
    Triple(R.drawable.ic_home, "Home", 0),
    Triple(R.drawable.ic_swap, "Transfer", 1),
    Triple(R.drawable.ic_dev, "Devices", 2),
    Triple(R.drawable.ic_hist, "History", 3),
    Triple(R.drawable.ic_gear, "Settings", 4),
  )
  return LinearLayout(this).apply {
    orientation = LinearLayout.HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
    val top = dp(10); val side = dp(4); val bottom = dp(8)
    setPadding(side, top, side, bottom)
    background = GlassDrawable(dp(24).toFloat(),
      startColor = D.argb(204, D.ELEVATED), endColor = D.argb(204, D.ELEVATED),
      strokeColor = D.LINE, angleDeg = 90f)
    elevation = dp(8).toFloat()
    layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
    tabs.forEach { (icon, label, idx) ->
      val item = LinearLayout(this@bottomNav).apply {
        orientation = LinearLayout.VERTICAL
        gravity = Gravity.CENTER
        setPadding(dp(6), dp(2), dp(6), dp(2))
        layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT).apply { weight = 1f }
        if (idx == active) {
          // .nav .a glow — a soft teal halo behind the active icon
          background = android.graphics.drawable.GradientDrawable().apply {
            shape = android.graphics.drawable.GradientDrawable.OVAL
            setColor(D.argb(20, D.PRIMARY))
          }
        }
        setOnClickListener { onSelect(idx) }
      }
      val iv = ImageView(this@bottomNav).apply {
        setImageResource(icon)
        imageTintList = ColorStateList.valueOf(if (idx == active) D.PRIMARY else D.NAV_IDLE)
        layoutParams = LinearLayout.LayoutParams(dp(19), dp(19))
      }
      val tv = TextView(this@bottomNav).apply {
        text = label
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 10f)
        typeface = Fonts.manrope(this@bottomNav, 600)
        includeFontPadding = false
        setTextColor(if (idx == active) D.PRIMARY else D.NAV_IDLE)
        gravity = Gravity.CENTER
      }
      item.addView(iv)
      val gap = android.widget.Space(this@bottomNav)
      gap.layoutParams = LinearLayout.LayoutParams(1, dp(3))
      item.addView(gap)
      item.addView(tv)
      addView(item)
    }
  }
}
