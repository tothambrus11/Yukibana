fun main() {
    print("Name? ")
    val name = readln()
    val n = readln().toInt()
    println("Hello, $name! ${(1..n).sum()} ${1.0 / 3} ${listOf(3, 1, 2).sorted()}")
}
