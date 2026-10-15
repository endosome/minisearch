//! Engine counters and phase timers for profiling, compiled only with the
//! `stats` feature. Without it `stat!` and `phase!` expand to nothing, so the
//! published build carries none of this. Read and reset from JavaScript with
//! `MiniSearchWasm.engineStats()` / `resetEngineStats()`.
//!
//! Counters are plain sums since the last reset. Phases nest: `accumulate`
//! includes `expand`. Only the fused path (`fusedQueries`) is split into
//! `accumulate`, `rank` and `transfer`; the map-based path
//! (`rawTextQueries`: query trees, filters by object, dirty retries) shows up
//! in `plan` and `expand` only. Timing a phase costs a clock read at each end, so an
//! instrumented build is slower than a release build and its timings are for
//! comparing phases, not for quoting.

#[cfg(feature = "stats")]
mod imp {
    use std::alloc::{GlobalAlloc, Layout, System};
    use std::cell::Cell;
    use std::sync::atomic::{AtomicUsize, Ordering};

    macro_rules! counters {
        ($($name:ident => $key:literal),* $(,)?) => {
            #[derive(Clone, Copy)]
            #[allow(non_camel_case_types)]
            pub enum Counter { $($name),* }
            const COUNTER_KEYS: &[&str] = &[$($key),*];
        };
    }

    counters! {
        FusedQueries => "fusedQueries",
        RawTextQueries => "rawTextQueries",
        DirtyRetries => "dirtyRetries",
        Specs => "specs",
        PrefixCacheHits => "prefixCacheHits",
        PrefixCacheMisses => "prefixCacheMisses",
        FuzzyCacheHits => "fuzzyCacheHits",
        FuzzyCacheMisses => "fuzzyCacheMisses",
        TrieEdges => "trieEdges",
        MyersTransitions => "myersTransitions",
        MatrixRows => "matrixRows",
        ExpansionsFound => "expansionsFound",
        ExpansionsUsed => "expansionsUsed",
        ExpansionsSkipped => "expansionsSkipped",
        PostingLists => "postingLists",
        PostingsVisited => "postingsVisited",
        PostingsLive => "postingsLive",
        Tombstones => "tombstones",
        InternCalls => "internCalls",
        TermsInterned => "termsInterned",
        DocsTouched => "docsTouched",
        HitsKept => "hitsKept",
        RowsMaterialized => "rowsMaterialized",
    }

    macro_rules! phases {
        ($($name:ident => $key:literal),* $(,)?) => {
            #[derive(Clone, Copy)]
            #[allow(non_camel_case_types)]
            pub enum Phase { $($name),* }
            const PHASE_KEYS: &[&str] = &[$($key),*];
        };
    }

    phases! {
        Plan => "plan",
        Expand => "expand",
        Accumulate => "accumulate",
        Rank => "rank",
        Transfer => "transfer",
    }

    const COUNTERS: usize = COUNTER_KEYS.len();
    const PHASES: usize = PHASE_KEYS.len();

    thread_local! {
        static COUNTS: [Cell<u64>; COUNTERS] = const { [const { Cell::new(0) }; COUNTERS] };
        static TIMES: [Cell<f64>; PHASES] = const { [const { Cell::new(0.0) }; PHASES] };
        static CALLS: [Cell<u64>; PHASES] = const { [const { Cell::new(0) }; PHASES] };
    }

    #[inline]
    pub fn add(counter: Counter, n: u64) {
        COUNTS.with(|counts| {
            let cell = &counts[counter as usize];
            cell.set(cell.get() + n);
        });
    }

    #[cfg(target_arch = "wasm32")]
    mod clock {
        use wasm_bindgen::prelude::*;
        #[wasm_bindgen]
        extern "C" {
            #[wasm_bindgen(js_namespace = performance, js_name = now)]
            fn performance_now() -> f64;
        }
        pub fn now_ms() -> f64 {
            performance_now()
        }
    }

    #[cfg(not(target_arch = "wasm32"))]
    mod clock {
        use std::sync::OnceLock;
        use std::time::Instant;
        static START: OnceLock<Instant> = OnceLock::new();
        pub fn now_ms() -> f64 {
            START.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0
        }
    }

    /// Adds the time until it is dropped to its phase.
    pub struct PhaseGuard {
        phase: Phase,
        start: f64,
    }

    impl PhaseGuard {
        pub fn start(phase: Phase) -> Self {
            PhaseGuard {
                phase,
                start: clock::now_ms(),
            }
        }
    }

    impl Drop for PhaseGuard {
        fn drop(&mut self) {
            let elapsed = clock::now_ms() - self.start;
            let index = self.phase as usize;
            TIMES.with(|times| times[index].set(times[index].get() + elapsed));
            CALLS.with(|calls| calls[index].set(calls[index].get() + 1));
        }
    }

    /// Counts the bytes the Rust allocator has handed out and not taken back,
    /// and the highest that count reached since the last reset. Installed in
    /// the Wasm build only; natively both figures stay 0.
    #[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
    pub struct CountingAllocator;

    static LIVE: AtomicUsize = AtomicUsize::new(0);
    static PEAK: AtomicUsize = AtomicUsize::new(0);

    fn grew(bytes: usize) {
        let live = LIVE.fetch_add(bytes, Ordering::Relaxed) + bytes;
        PEAK.fetch_max(live, Ordering::Relaxed);
    }

    unsafe impl GlobalAlloc for CountingAllocator {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            let pointer = unsafe { System.alloc(layout) };
            if !pointer.is_null() {
                grew(layout.size());
            }
            pointer
        }
        unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
            let pointer = unsafe { System.alloc_zeroed(layout) };
            if !pointer.is_null() {
                grew(layout.size());
            }
            pointer
        }
        unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
            unsafe { System.dealloc(pointer, layout) };
            LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
        }
        unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
            let moved = unsafe { System.realloc(pointer, layout, new_size) };
            if !moved.is_null() {
                if new_size >= layout.size() {
                    grew(new_size - layout.size());
                } else {
                    LIVE.fetch_sub(layout.size() - new_size, Ordering::Relaxed);
                }
            }
            moved
        }
    }

    /// The counters, phase times (ms) and call counts, allocator bytes and
    /// `scratch` (the retained per-query scratch, from the engine) as JSON.
    pub fn snapshot(scratch: (usize, usize)) -> String {
        let mut out = String::from("{\"counters\":{");
        COUNTS.with(|counts| {
            for (index, key) in COUNTER_KEYS.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                out.push_str(&format!("\"{key}\":{}", counts[index].get()));
            }
        });
        out.push_str("},\"phases\":{");
        TIMES.with(|times| {
            CALLS.with(|calls| {
                for (index, key) in PHASE_KEYS.iter().enumerate() {
                    if index > 0 {
                        out.push(',');
                    }
                    out.push_str(&format!(
                        "\"{key}\":{{\"ms\":{},\"calls\":{}}}",
                        times[index].get(),
                        calls[index].get()
                    ));
                }
            })
        });
        out.push_str(&format!(
            "}},\"allocLiveBytes\":{},\"allocPeakBytes\":{},\"scratchDocSlots\":{},\"scratchRetainedBytes\":{}}}",
            LIVE.load(Ordering::Relaxed),
            PEAK.load(Ordering::Relaxed),
            scratch.0,
            scratch.1
        ));
        out
    }

    pub fn reset() {
        COUNTS.with(|counts| counts.iter().for_each(|cell| cell.set(0)));
        TIMES.with(|times| times.iter().for_each(|cell| cell.set(0.0)));
        CALLS.with(|calls| calls.iter().for_each(|cell| cell.set(0)));
        PEAK.store(LIVE.load(Ordering::Relaxed), Ordering::Relaxed);
    }
}

#[cfg(feature = "stats")]
pub use imp::*;

/// `stat!(Counter, n)` adds `n` to an engine counter (`stats` builds only).
macro_rules! stat {
    ($counter:ident, $n:expr) => {
        #[cfg(feature = "stats")]
        $crate::stats::add($crate::stats::Counter::$counter, ($n) as u64);
    };
}

/// `phase!(Phase)` times the rest of the enclosing block (`stats` builds only).
macro_rules! phase {
    ($phase:ident) => {
        #[cfg(feature = "stats")]
        let _phase_guard = $crate::stats::PhaseGuard::start($crate::stats::Phase::$phase);
    };
}

/// `phase_begin!(name, Phase)` starts timing a phase that `phase_end!(name)`
/// ends, for spans that are not a block of their own.
macro_rules! phase_begin {
    ($name:ident, $phase:ident) => {
        #[cfg(feature = "stats")]
        let $name = $crate::stats::PhaseGuard::start($crate::stats::Phase::$phase);
    };
}

macro_rules! phase_end {
    ($name:ident) => {
        #[cfg(feature = "stats")]
        drop($name);
    };
}

pub(crate) use {phase, phase_begin, phase_end, stat};

#[cfg(all(test, feature = "stats"))]
mod tests {
    use crate::{MiniSearch, MiniSearchOptions, PartialSearchOptions};
    use serde_json::{json, Value};

    fn counters() -> Value {
        let snapshot: Value = serde_json::from_str(&super::snapshot((0, 0))).unwrap();
        snapshot["counters"].clone()
    }

    #[test]
    fn counts_one_fused_query_and_its_work() {
        let options: MiniSearchOptions =
            serde_json::from_value(json!({"fields": ["title", "text"], "autoVacuum": false}))
                .unwrap();
        let mut index = MiniSearch::new(options);
        for (id, title, text) in [
            (1, "apple pie", "baked apples"),
            (2, "apricot jam", "sweet"),
            (3, "banana", "apple banana smoothie"),
        ] {
            index
                .add(json!({"id": id, "title": title, "text": text}))
                .unwrap();
        }
        let per_call: PartialSearchOptions =
            serde_json::from_value(json!({"prefix": true, "fuzzy": 0.2})).unwrap();

        super::reset();
        let results = index.search_raw("ap", &per_call);
        let first = counters();
        assert_eq!(first["fusedQueries"], 1);
        assert_eq!(first["specs"], 1);
        assert_eq!(first["prefixCacheMisses"], 1);
        assert_eq!(first["rowsMaterialized"], results.doc_ids.len() as u64);
        assert_eq!(first["hitsKept"], results.doc_ids.len() as u64);
        // "apple" (title, text), "apples" (text), "apricot" (title).
        assert_eq!(first["postingLists"], 4);
        assert_eq!(first["postingsVisited"], 4);
        assert_eq!(first["tombstones"], 0);
        assert!(first["trieEdges"].as_u64().unwrap() > 0);

        // The same query again: the expansions come from the cache.
        index.search_raw("ap", &per_call);
        let second = counters();
        assert_eq!(second["fusedQueries"], 2);
        assert_eq!(second["prefixCacheHits"], 1);
        assert_eq!(second["trieEdges"], first["trieEdges"]);

        // A discarded document leaves tombstones, and the exact path retries.
        index.discard(&json!(1)).unwrap();
        super::reset();
        index.search_raw_exact("apple", &PartialSearchOptions::default());
        let dirty = counters();
        assert!(dirty["tombstones"].as_u64().unwrap() > 0);
        assert_eq!(dirty["dirtyRetries"], 1);
    }
}
