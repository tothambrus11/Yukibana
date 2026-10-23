package xsbti

/** Mirror of the compiler-interface Java enum (used by the typer's
 *  incremental-compilation bookkeeping, which is inert here). */
enum UseScope extends java.lang.Enum[UseScope] {
  case Default, Implicit, PatMatTarget
}
