package xsbti.api

/** Mirror of the compiler-interface Java enum. */
enum DependencyContext extends java.lang.Enum[DependencyContext] {
  case DependencyByMemberRef, DependencyByInheritance, LocalDependencyByInheritance, DependencyByMacroExpansion
}
