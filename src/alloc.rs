//! The global allocator on Wasm: dlmalloc, the allocator std uses there, with
//! linear memory grown in larger steps.
//!
//! Each `memory.grow` replaces the module's `ArrayBuffer`, and V8 counts the
//! growth as external memory: growing a page at a time starts a full garbage
//! collection every few grows. std's dlmalloc asks for about what one request
//! needs, so indexing a large corpus grew memory thousands of times, each time
//! collecting a JavaScript heap that also holds the corpus: the cost was
//! quadratic in the corpus size (357 s for 1M documents, against 38 s here).
//!
//! [`GrowAhead`] is dlmalloc's Wasm system allocator, except that it grows by
//! at least an eighth of the current memory (1 MiB to 64 MiB) and hands the
//! whole region to dlmalloc, which allocates from it as from any segment. The
//! number of grows becomes logarithmic in the final size, plus one per 64 MiB.

use dlmalloc::{Allocator, Dlmalloc};
use std::alloc::{GlobalAlloc, Layout};
use std::arch::wasm32::{memory_grow, memory_size};
use std::cell::UnsafeCell;
use std::ptr;

const PAGE: usize = 64 * 1024;
/// Least and most pages grown at once, beyond what a request needs.
const MIN_STEP: usize = 16;
const MAX_STEP: usize = 1024;

pub struct GrowAhead;

// SAFETY: as dlmalloc's own Wasm `System`, except for the size of each grow.
unsafe impl Allocator for GrowAhead {
    fn alloc(&self, size: usize) -> (*mut u8, usize, u32) {
        let needed = size.div_ceil(PAGE);
        let step = (memory_size(0) / 8).clamp(MIN_STEP, MAX_STEP);
        // Near the end of the address space the larger step can fail where
        // the request alone still fits.
        for pages in [needed.max(step), needed] {
            let previous = memory_grow(0, pages);
            if previous == usize::MAX {
                continue;
            }
            let base = previous * PAGE;
            let size = pages * PAGE;
            // A region ending at the top of the address space would make a
            // pointer wrap to 0; keep its last bytes out (as dlmalloc does).
            let size = if base.wrapping_add(size) == 0 {
                size - 16
            } else {
                size
            };
            return (base as *mut u8, size, 0);
        }
        (ptr::null_mut(), 0, 0)
    }

    fn remap(&self, _ptr: *mut u8, _old: usize, _new: usize, _can_move: bool) -> *mut u8 {
        ptr::null_mut()
    }

    fn free_part(&self, _ptr: *mut u8, _old: usize, _new: usize) -> bool {
        false
    }

    fn free(&self, _ptr: *mut u8, _size: usize) -> bool {
        false
    }

    fn can_release_part(&self, _flags: u32) -> bool {
        false
    }

    fn allocates_zeros(&self) -> bool {
        true
    }

    fn page_size(&self) -> usize {
        PAGE
    }
}

/// dlmalloc over [`GrowAhead`] as the global allocator.
pub struct Global(UnsafeCell<Dlmalloc<GrowAhead>>);

impl Global {
    pub const fn new() -> Self {
        Global(UnsafeCell::new(Dlmalloc::new_with_allocator(GrowAhead)))
    }
}

// SAFETY: this target has no threads (no `atomics` feature): there is never a
// second caller while one runs.
unsafe impl Sync for Global {}

// SAFETY: forwards to dlmalloc, which upholds `GlobalAlloc`'s contract; calls
// never overlap (see the `Sync` impl), so the exclusive borrows are sound.
unsafe impl GlobalAlloc for Global {
    #[inline]
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        unsafe { (*self.0.get()).malloc(layout.size(), layout.align()) }
    }
    #[inline]
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        unsafe { (*self.0.get()).calloc(layout.size(), layout.align()) }
    }
    #[inline]
    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        unsafe { (*self.0.get()).free(pointer, layout.size(), layout.align()) }
    }
    #[inline]
    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        unsafe { (*self.0.get()).realloc(pointer, layout.size(), layout.align(), new_size) }
    }
}
