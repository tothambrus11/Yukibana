// Linked into every C++ program the runner builds (build-cxx-runtime.sh
// compiles it into the WASI sysroot as yukibana-uncaught.o).
//
// With WebAssembly exception handling a C++ exception nobody catches is not
// a call to std::terminate: the `throw` instruction finds no handler, and
// the exception leaves _start as a WebAssembly.Exception in the runner's
// JavaScript. The runner then hands the exception's payload (the
// _Unwind_Exception pointer, the __cpp_exception tag's only argument) to
// this function, which throws it again, catches it, and calls
// std::terminate from inside the handler. libc++abi's default terminate
// handler then prints what a native program prints,
//
//   libc++abi: terminating due to uncaught exception of type std::logic_error: boom
//
// and calls abort(), a trap the runner reports with exit status 134.

#include <exception>
#include <unwind.h>

extern "C" __attribute__((export_name("__yukibana_uncaught"))) void __yukibana_uncaught(void *exception) {
    try {
        _Unwind_RaiseException(static_cast<_Unwind_Exception *>(exception));
    } catch (...) {
        std::terminate();
    }
}
