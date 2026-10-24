data class Point(val x: Double, val y: Double)

fun Point.distanceTo(o: Point): Double = kotlin.math.sqrt((x - o.x) * (x - o.x) + (y - o.y) * (y - o.y))

fun main() {
    val a = Point(0.0, 0.0)
    val b = Point(3.0, 4.0)
    val ps = listOf(a, b).map { it.copy(x = it.x + 1) }
    println("$a to $b: ${a.distanceTo(b)}")
    println(ps.joinToString())
}
