use std::cell::RefCell;
use std::sync::OnceLock;

use wasmtime::{Caller, Config, Engine, Instance as WasmInstance, Linker, Memory, Module, Store, TypedFunc};

use crate::versions::{EttVersion, ALL_VERSIONS};

#[cfg(not(any(feature = "jit", feature = "aot")))]
compile_error!("leoblack-ett needs the `jit` or the `aot` feature to run MinaCalc");

/// The MinaCalc builds, one per distinct wasm: 0.72.0 and 0.72.3 are the
/// same build, byte for byte, so they share one (see [`build`]).
const BUILDS: usize = 5;

/// Which of the builds `version` runs.
fn build(version: EttVersion) -> usize {
    match version {
        EttVersion::V0680Unofficial => 0,
        EttVersion::V0700 => 1,
        EttVersion::V0720 | EttVersion::V0723 => 2,
        EttVersion::V0740 => 3,
        EttVersion::V0750 => 4,
    }
}

/// A build of the `legacy-builds` feature: left out, file and all, without it.
#[cfg(feature = "legacy-builds")]
macro_rules! legacy {
    ($bytes:expr) => {
        Some($bytes)
    };
}
#[cfg(not(feature = "legacy-builds"))]
macro_rules! legacy {
    ($bytes:expr) => {
        None
    };
}

/// The builds by [`build`], as wasm (`jit`) or compiled for the target by
/// `build.rs` (`aot`); `None` for the ones left out.
macro_rules! minacalc_builds {
    ($ext:literal, $dir:expr) => {
        [
            legacy!(include_bytes!(concat!($dir, "/minaclac-68.0-unofficial.", $ext))),
            legacy!(include_bytes!(concat!($dir, "/minaclac-70.0.", $ext))),
            Some(include_bytes!(concat!($dir, "/minaclac-72.3.", $ext))),
            Some(include_bytes!(concat!($dir, "/minaclac-74.0.", $ext))),
            Some(include_bytes!(concat!($dir, "/minaclac-75.0.", $ext))),
        ]
    };
}

#[cfg(feature = "aot")]
static PRECOMPILED: [Option<&[u8]>; BUILDS] = minacalc_builds!("cwasm", env!("OUT_DIR"));
#[cfg(not(feature = "aot"))]
static WASM_BYTES: [Option<&[u8]>; BUILDS] = minacalc_builds!("wasm", "../minacalc");

/// Whether the build of `version` is in this binary (see `legacy-builds`).
pub fn is_built_in(version: EttVersion) -> bool {
    #[cfg(feature = "aot")]
    let builds = &PRECOMPILED;
    #[cfg(not(feature = "aot"))]
    let builds = &WASM_BYTES;
    builds[build(version)].is_some()
}

pub const OUT_COUNT: usize = 8;

fn engine() -> &'static Engine {
    static ENGINE: OnceLock<Engine> = OnceLock::new();
    ENGINE.get_or_init(|| {
        #[allow(unused_mut)]
        let mut config = Config::new();
        // The same as `build.rs` compiles with, for `aot`.
        #[cfg(not(feature = "aot"))]
        config.cranelift_opt_level(wasmtime::OptLevel::Speed);
        Engine::new(&config).expect("wasmtime engine")
    })
}

/// The compiled build of `version`, shared by the versions of the same build.
///
/// # Panics
///
/// If it isn't built in (see [`is_built_in`]).
pub fn module(version: EttVersion) -> &'static Module {
    static MODULES: [OnceLock<Module>; BUILDS] = [const { OnceLock::new() }; BUILDS];
    MODULES[build(version)].get_or_init(|| load(build(version)).unwrap_or_else(|e| panic!("load {}: {e}", version.key())))
}

#[cfg(feature = "aot")]
fn load(build: usize) -> wasmtime::Result<Module> {
    // SAFETY: `build.rs` compiled these, with this same wasmtime, for this
    // target; wasmtime checks both before loading them.
    let bytes = PRECOMPILED[build].ok_or_else(|| wasmtime::Error::msg("not built in"))?;
    unsafe { Module::deserialize(engine(), bytes) }
}

#[cfg(not(feature = "aot"))]
fn load(build: usize) -> wasmtime::Result<Module> {
    let bytes = WASM_BYTES[build].ok_or_else(|| wasmtime::Error::msg("not built in"))?;
    Module::new(engine(), bytes)
}

/// Compiles (`jit`) or loads (`aot`) every build in this binary.
pub fn precompile_all() {
    for v in ALL_VERSIONS.into_iter().filter(|&v| is_built_in(v)) {
        module(v);
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Glue {
    Old,
    New,
}

struct Names {
    glue: Glue,
    abort: &'static str,
    fd_write: &'static str,
    fd_read: &'static str,
    fd_close: &'static str,
    fd_seek: &'static str,
    environ_get: &'static str,
    environ_sizes_get: &'static str,
    resize_heap: &'static str,
    memcpy_big: &'static str,
    strftime_l: &'static str,
    cxa_throw: &'static str,
    cxa_allocate_exception: &'static str,
    memory: &'static str,
    ctors: &'static str,
    compute: &'static str,
    malloc: &'static str,
    free: &'static str,
}

fn names(version: EttVersion) -> Names {
    match version {
        EttVersion::V0680Unofficial => Names {
            glue: Glue::Old,
            abort: "a",
            fd_write: "b",
            environ_get: "c",
            environ_sizes_get: "d",
            fd_close: "e",
            fd_read: "f",
            resize_heap: "g",
            memcpy_big: "h",
            fd_seek: "i",
            strftime_l: "j",
            cxa_throw: "k",
            cxa_allocate_exception: "l",
            memory: "m",
            ctors: "n",
            compute: "p",
            malloc: "q",
            free: "r",
        },
        EttVersion::V0700 => Names {
            glue: Glue::Old,
            abort: "a",
            fd_write: "b",
            cxa_throw: "c",
            cxa_allocate_exception: "d",
            environ_get: "e",
            environ_sizes_get: "f",
            fd_close: "g",
            fd_read: "h",
            resize_heap: "i",
            memcpy_big: "j",
            fd_seek: "k",
            strftime_l: "l",
            memory: "m",
            ctors: "n",
            compute: "o",
            malloc: "q",
            free: "r",
        },
        EttVersion::V0720 | EttVersion::V0723 => Names {
            glue: Glue::Old,
            fd_write: "a",
            abort: "b",
            cxa_throw: "c",
            cxa_allocate_exception: "d",
            environ_get: "e",
            environ_sizes_get: "f",
            fd_close: "g",
            fd_read: "h",
            resize_heap: "i",
            memcpy_big: "j",
            fd_seek: "k",
            strftime_l: "l",
            memory: "m",
            ctors: "n",
            compute: "o",
            malloc: "q",
            free: "r",
        },
        EttVersion::V0740 | EttVersion::V0750 => Names {
            glue: Glue::New,
            abort: "_abort_js",
            fd_write: "fd_write",
            fd_read: "fd_read",
            fd_close: "fd_close",
            fd_seek: "fd_seek",
            environ_get: "environ_get",
            environ_sizes_get: "environ_sizes_get",
            resize_heap: "emscripten_resize_heap",
            memcpy_big: "",
            strftime_l: "",
            cxa_throw: "",
            cxa_allocate_exception: "",
            memory: "memory",
            ctors: "__wasm_call_ctors",
            compute: "minacalc_compute",
            malloc: "malloc",
            free: "free",
        },
    }
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct ImportCalls {
    pub abort: u32,
    pub fd_write: u32,
    pub fd_read: u32,
    pub fd_close: u32,
    pub fd_seek: u32,
    pub environ: u32,
    pub resize_heap: u32,
    pub memcpy_big: u32,
    pub strftime: u32,
    pub tzset: u32,
    pub cxa_throw: u32,
}

#[derive(Debug, Clone)]
pub struct JsThrow {
    pub message: String,
}

impl std::fmt::Display for JsThrow {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for JsThrow {}

fn env_strings() -> Vec<String> {
    vec![
        "USER=web_user".into(),
        "LOGNAME=web_user".into(),
        "PATH=/".into(),
        "PWD=/".into(),
        "HOME=/home/web_user".into(),
        "LANG=en_US.UTF-8".into(),
        "_=./this.program".into(),
    ]
}

static TOTAL_CALLS: std::sync::Mutex<ImportCalls> = std::sync::Mutex::new(ImportCalls {
    abort: 0, fd_write: 0, fd_read: 0, fd_close: 0, fd_seek: 0, environ: 0, resize_heap: 0, memcpy_big: 0,
    strftime: 0, tzset: 0, cxa_throw: 0,
});

pub fn total_import_calls() -> ImportCalls {
    *TOTAL_CALLS.lock().unwrap()
}

fn bump(c: &mut Caller<'_, Host>, field: fn(&mut ImportCalls) -> &mut u32) {
    *field(&mut c.data_mut().calls) += 1;
    *field(&mut TOTAL_CALLS.lock().unwrap()) += 1;
}

struct Host {
    memory: Option<Memory>,
    malloc: Option<TypedFunc<i32, i32>>,
    calls: ImportCalls,
}

fn mem<'a>(caller: &'a mut Caller<'_, Host>) -> &'a mut [u8] {
    let m = caller.data().memory.expect("memory export");
    m.data_mut(caller)
}

fn rd_u32(m: &[u8], addr: u32) -> u32 {
    let a = addr as usize;
    u32::from_le_bytes(m[a..a + 4].try_into().unwrap())
}
fn wr_u32(m: &mut [u8], addr: u32, v: u32) {
    let a = addr as usize;
    m[a..a + 4].copy_from_slice(&v.to_le_bytes());
}

fn abort_message(glue: Glue) -> &'static str {
    match glue {
        Glue::Old => "Aborted(). Build with -s ASSERTIONS=1 for more info.",
        Glue::New => "Aborted(). Build with -sASSERTIONS for more info.",
    }
}

fn resize_heap(caller: &mut Caller<'_, Host>, requested: i32) -> i32 {
    bump(caller, |k| &mut k.resize_heap);
    let memory = caller.data().memory.expect("memory export");
    let old_size = memory.data_size(&*caller) as f64;
    let requested = requested as u32 as f64;
    let max_heap = 2147483648.0f64;
    if requested > max_heap {
        return 0;
    }
    let mut cut_down = 1.0f64;
    while cut_down <= 4.0 {
        let mut over_grown = old_size * (1.0 + 0.2 / cut_down);
        over_grown = jsmath::min(over_grown, requested + 100663296.0);
        let target = jsmath::max(requested, over_grown);
        let aligned = (target / 65536.0).ceil() * 65536.0;
        let new_size = jsmath::min(max_heap, aligned);
        let pages = ((new_size - old_size + 65535.0) / 65536.0).trunc();
        if pages >= 0.0 && memory.grow(&mut *caller, pages as u64).is_ok() {
            return 1;
        }
        cut_down *= 2.0;
    }
    0
}

fn fd_write(caller: &mut Caller<'_, Host>, fd: i32, iov: i32, iovcnt: i32, pnum: i32) -> i32 {
    bump(caller, |k| &mut k.fd_write);
    if !(0..=2).contains(&fd) {
        return 8;
    }
    let m = mem(caller);
    let mut num: u32 = 0;
    for i in 0..iovcnt.max(0) as u32 {
        let len = rd_u32(m, (iov as u32).wrapping_add(i * 8 + 4));
        num = num.wrapping_add(len);
    }
    wr_u32(m, pnum as u32, num);
    0
}

fn environ_sizes_get(caller: &mut Caller<'_, Host>, pcount: i32, pbuf: i32) -> i32 {
    bump(caller, |k| &mut k.environ);
    let strings = env_strings();
    let size: usize = strings.iter().map(|s| s.len() + 1).sum();
    let m = mem(caller);
    wr_u32(m, pcount as u32, strings.len() as u32);
    wr_u32(m, pbuf as u32, size as u32);
    0
}

fn environ_get(caller: &mut Caller<'_, Host>, environ: i32, buf: i32) -> i32 {
    bump(caller, |k| &mut k.environ);
    let m = mem(caller);
    let mut off = 0u32;
    for (i, s) in env_strings().iter().enumerate() {
        let ptr = (buf as u32).wrapping_add(off);
        wr_u32(m, (environ as u32).wrapping_add(i as u32 * 4), ptr);
        let a = ptr as usize;
        m[a..a + s.len()].copy_from_slice(s.as_bytes());
        m[a + s.len()] = 0;
        off += s.len() as u32 + 1;
    }
    0
}

fn throw(message: impl Into<String>) -> wasmtime::Error {
    wasmtime::Error::new(JsThrow { message: message.into() })
}

fn build_linker(version: EttVersion) -> Linker<Host> {
    let n = names(version);
    let mut l: Linker<Host> = Linker::new(engine());
    let glue = n.glue;
    match glue {
        Glue::Old => {
            let m = "a";
            l.func_wrap(m, n.abort, move |mut c: Caller<'_, Host>| -> wasmtime::Result<()> {
                bump(&mut c, |k| &mut k.abort);
                Err(throw(abort_message(Glue::Old)))
            })
            .unwrap();
            l.func_wrap(m, n.fd_write, |mut c: Caller<'_, Host>, fd: i32, iov: i32, cnt: i32, pnum: i32| {
                fd_write(&mut c, fd, iov, cnt, pnum)
            })
            .unwrap();
            l.func_wrap(m, n.fd_read, |mut c: Caller<'_, Host>, _fd: i32, _iov: i32, _cnt: i32, _pnum: i32| -> wasmtime::Result<i32> {
                bump(&mut c, |k| &mut k.fd_read);
                Err(throw("leoblack-ett: fd_read is not hosted"))
            })
            .unwrap();
            l.func_wrap(m, n.fd_close, |mut c: Caller<'_, Host>, fd: i32| -> i32 {
                bump(&mut c, |k| &mut k.fd_close);
                if (0..=2).contains(&fd) { 0 } else { 8 }
            })
            .unwrap();
            l.func_wrap(m, n.fd_seek, |mut c: Caller<'_, Host>, fd: i32, _lo: i32, _hi: i32, _wh: i32, _out: i32| -> i32 {
                bump(&mut c, |k| &mut k.fd_seek);
                if (0..=2).contains(&fd) { 70 } else { 8 }
            })
            .unwrap();
            l.func_wrap(m, n.environ_get, |mut c: Caller<'_, Host>, a: i32, b: i32| environ_get(&mut c, a, b)).unwrap();
            l.func_wrap(m, n.environ_sizes_get, |mut c: Caller<'_, Host>, a: i32, b: i32| environ_sizes_get(&mut c, a, b))
                .unwrap();
            l.func_wrap(m, n.resize_heap, |mut c: Caller<'_, Host>, req: i32| resize_heap(&mut c, req)).unwrap();
            l.func_wrap(m, n.memcpy_big, |mut c: Caller<'_, Host>, dest: i32, src: i32, num: i32| -> i32 {
                bump(&mut c, |k| &mut k.memcpy_big);
                let mm = mem(&mut c);
                let (d, s, k) = (dest as u32 as usize, src as u32 as usize, num as u32 as usize);
                mm.copy_within(s..s + k, d);
                0
            })
            .unwrap();
            l.func_wrap(m, n.strftime_l, |mut c: Caller<'_, Host>, _s: i32, _max: i32, _f: i32, _tm: i32, _loc: i32| -> wasmtime::Result<i32> {
                bump(&mut c, |k| &mut k.strftime);
                Err(throw("leoblack-ett: strftime_l is not hosted"))
            })
            .unwrap();
            l.func_wrap(m, n.cxa_allocate_exception, |mut c: Caller<'_, Host>, size: i32| -> wasmtime::Result<i32> {
                let malloc = c.data().malloc.clone().expect("malloc export");
                let p = malloc.call(&mut c, size.wrapping_add(16))?;
                Ok(p.wrapping_add(16))
            })
            .unwrap();
            l.func_wrap(m, n.cxa_throw, |mut c: Caller<'_, Host>, ptr: i32, ty: i32, destructor: i32| -> wasmtime::Result<()> {
                bump(&mut c, |k| &mut k.cxa_throw);
                let mm = mem(&mut c);
                let base = (ptr as u32).wrapping_sub(16);
                wr_u32(mm, base.wrapping_add(4), ty as u32);
                wr_u32(mm, base.wrapping_add(8), destructor as u32);
                wr_u32(mm, base, 0);
                mm[base.wrapping_add(12) as usize] = 0;
                mm[base.wrapping_add(13) as usize] = 0;
                Err(throw(format!("minacalc compute threw: {ptr}")))
            })
            .unwrap();
        }
        Glue::New => {
            l.func_wrap("env", "_abort_js", |mut c: Caller<'_, Host>| -> wasmtime::Result<()> {
                bump(&mut c, |k| &mut k.abort);
                Err(throw(abort_message(Glue::New)))
            })
            .unwrap();
            l.func_wrap("env", "_tzset_js", |mut c: Caller<'_, Host>, timezone: i32, daylight: i32, std_name: i32, dst_name: i32| {
                bump(&mut c, |k| &mut k.tzset);
                let mm = mem(&mut c);
                wr_u32(mm, timezone as u32, 0);
                wr_u32(mm, daylight as u32, 0);
                for p in [std_name, dst_name] {
                    let a = p as u32 as usize;
                    mm[a..a + 8].copy_from_slice(b"UTC-0000");
                    mm[a + 8] = 0;
                }
            })
            .unwrap();
            l.func_wrap("env", "emscripten_resize_heap", |mut c: Caller<'_, Host>, req: i32| resize_heap(&mut c, req)).unwrap();
            let w = "wasi_snapshot_preview1";
            l.func_wrap(w, "fd_write", |mut c: Caller<'_, Host>, fd: i32, iov: i32, cnt: i32, pnum: i32| {
                fd_write(&mut c, fd, iov, cnt, pnum)
            })
            .unwrap();
            l.func_wrap(w, "fd_read", |mut c: Caller<'_, Host>, _fd: i32, _iov: i32, _cnt: i32, _pnum: i32| -> wasmtime::Result<i32> {
                bump(&mut c, |k| &mut k.fd_read);
                Err(throw("leoblack-ett: fd_read is not hosted"))
            })
            .unwrap();
            l.func_wrap(w, "fd_close", |mut c: Caller<'_, Host>, fd: i32| -> i32 {
                bump(&mut c, |k| &mut k.fd_close);
                if (0..=2).contains(&fd) { 0 } else { 8 }
            })
            .unwrap();
            l.func_wrap(w, "fd_seek", |mut c: Caller<'_, Host>, fd: i32, _off: i64, _wh: i32, _out: i32| -> i32 {
                bump(&mut c, |k| &mut k.fd_seek);
                if (0..=2).contains(&fd) { 70 } else { 8 }
            })
            .unwrap();
            l.func_wrap(w, "environ_get", |mut c: Caller<'_, Host>, a: i32, b: i32| environ_get(&mut c, a, b)).unwrap();
            l.func_wrap(w, "environ_sizes_get", |mut c: Caller<'_, Host>, a: i32, b: i32| environ_sizes_get(&mut c, a, b)).unwrap();
        }
    }
    l
}

fn trap_message(trap: &wasmtime::Trap) -> String {
    use wasmtime::Trap::*;
    match trap {
        StackOverflow => "Maximum call stack size exceeded",
        MemoryOutOfBounds | HeapMisaligned => "memory access out of bounds",
        TableOutOfBounds => "table index is out of bounds",
        IndirectCallToNull | BadSignature => "null function or function signature mismatch",
        IntegerOverflow => "divide result unrepresentable",
        IntegerDivisionByZero => "divide by zero",
        BadConversionToInteger => "float unrepresentable in integer range",
        UnreachableCodeReached => "unreachable",
        _ => return format!("{trap}"),
    }
    .to_string()
}

fn js_error(err: wasmtime::Error) -> JsThrow {
    if let Some(t) = err.downcast_ref::<JsThrow>() {
        return t.clone();
    }
    if let Some(trap) = err.downcast_ref::<wasmtime::Trap>() {
        return JsThrow { message: trap_message(trap) };
    }
    JsThrow { message: format!("{err:#}") }
}

fn clean_image(version: EttVersion, current: &[u8]) -> std::sync::Arc<Vec<u8>> {
    static IMAGES: [OnceLock<std::sync::Arc<Vec<u8>>>; 6] =
        [OnceLock::new(), OnceLock::new(), OnceLock::new(), OnceLock::new(), OnceLock::new(), OnceLock::new()];
    let image = IMAGES[version.index()].get_or_init(|| std::sync::Arc::new(current.to_vec())).clone();
    debug_assert!(image.as_slice() == current, "{}: constructors left a different image", version.key());
    image
}

pub struct EttInstance {
    store: Store<Host>,
    memory: Memory,
    compute: TypedFunc<(i32, f32, f32, i32, i32, i32, i32), i32>,
    malloc: TypedFunc<i32, i32>,
    free: TypedFunc<i32, ()>,
    clean: std::sync::Arc<Vec<u8>>,
}

impl EttInstance {
    pub fn new(version: EttVersion) -> Result<EttInstance, JsThrow> {
        if !is_built_in(version) {
            return Err(JsThrow {
                message: format!("MinaCalc {} is not built in: it needs the `legacy-builds` feature", version.key()),
            });
        }
        let n = names(version);
        let module = module(version);
        let linker = build_linker(version);
        let mut store = Store::new(
            engine(),
            Host { memory: None, malloc: None, calls: ImportCalls::default() },
        );
        let inst: WasmInstance = linker.instantiate(&mut store, module).map_err(js_error)?;
        let memory = inst.get_memory(&mut store, n.memory).expect("memory export");
        let malloc = inst.get_typed_func::<i32, i32>(&mut store, n.malloc).map_err(js_error)?;
        let free = inst.get_typed_func::<i32, ()>(&mut store, n.free).map_err(js_error)?;
        let compute = inst
            .get_typed_func::<(i32, f32, f32, i32, i32, i32, i32), i32>(&mut store, n.compute)
            .map_err(js_error)?;
        let ctors = inst.get_typed_func::<(), ()>(&mut store, n.ctors).map_err(js_error)?;
        store.data_mut().memory = Some(memory);
        store.data_mut().malloc = Some(malloc.clone());
        ctors.call(&mut store, ()).map_err(js_error)?;
        let clean = clean_image(version, memory.data(&store));
        Ok(EttInstance { store, memory, compute, malloc, free, clean })
    }

    #[doc(hidden)]
    pub fn memory_equals_clean_image(&self) -> bool {
        self.memory.data(&self.store) == self.clean.as_slice()
    }

    #[doc(hidden)]
    pub fn restore_for_bench(&mut self) {
        self.restore_clean_memory();
    }

    pub fn import_calls(&self) -> ImportCalls {
        self.store.data().calls
    }

    fn restore_clean_memory(&mut self) {
        let data = self.memory.data_mut(&mut self.store);
        let n = self.clean.len();
        data[..n].copy_from_slice(&self.clean);
        if data.len() > n {
            data[n..].fill(0);
        }
    }

    pub fn run(
        &mut self,
        keycount: i32,
        music_rate: f64,
        score_goal: f64,
        row_masks: &[u32],
        row_times: &[f32],
    ) -> Result<[f32; OUT_COUNT], JsThrow> {
        self.restore_clean_memory();
        let masks_bytes = (row_masks.len() * 4) as i32;
        let times_bytes = (row_times.len() * 4) as i32;
        let out_bytes = (OUT_COUNT * 4) as i32;

        let ptr_masks = self.malloc.call(&mut self.store, masks_bytes).map_err(js_error)?;
        let ptr_times = self.malloc.call(&mut self.store, times_bytes).map_err(js_error)?;
        let ptr_out = self.malloc.call(&mut self.store, out_bytes).map_err(js_error)?;

        let result = (|| {
            {
                let data = self.memory.data_mut(&mut self.store);
                let base = ((ptr_masks as u32) >> 2) as usize * 4;
                for (i, m) in row_masks.iter().enumerate() {
                    data[base + i * 4..base + i * 4 + 4].copy_from_slice(&m.to_le_bytes());
                }
                let base = ((ptr_times as u32) >> 2) as usize * 4;
                for (i, t) in row_times.iter().enumerate() {
                    data[base + i * 4..base + i * 4 + 4].copy_from_slice(&t.to_le_bytes());
                }
            }
            let ok = self
                .compute
                .call(
                    &mut self.store,
                    (keycount, music_rate as f32, score_goal as f32, ptr_masks, ptr_times, row_masks.len() as i32, ptr_out),
                )
                .map_err(js_error)?;
            if ok == 0 {
                return Err(JsThrow { message: "minacalc_compute returned failure".into() });
            }
            let data = self.memory.data(&self.store);
            let base = ((ptr_out as u32) >> 2) as usize * 4;
            let mut out = [0f32; OUT_COUNT];
            for (i, o) in out.iter_mut().enumerate() {
                *o = f32::from_le_bytes(data[base + i * 4..base + i * 4 + 4].try_into().unwrap());
            }
            Ok(out)
        })();

        for p in [ptr_masks, ptr_times, ptr_out] {
            self.free.call(&mut self.store, p).map_err(js_error)?;
        }
        result
    }
}

thread_local! {
    static INSTANCES: RefCell<[Option<EttInstance>; 6]> = const { RefCell::new([None, None, None, None, None, None]) };
}

pub fn with_instance<T>(
    version: EttVersion,
    f: impl FnOnce(&mut EttInstance) -> Result<T, JsThrow>,
) -> Result<T, JsThrow> {
    INSTANCES.with(|cell| {
        let mut slots = cell.borrow_mut();
        let slot = &mut slots[version.index()];
        if slot.is_none() {
            *slot = Some(EttInstance::new(version)?);
        }
        let r = f(slot.as_mut().unwrap());
        if r.is_err() {
            *slot = None;
        }
        r
    })
}

pub fn evict(version: EttVersion) {
    INSTANCES.with(|cell| cell.borrow_mut()[version.index()] = None);
}

pub fn import_calls(version: EttVersion) -> Option<ImportCalls> {
    INSTANCES.with(|cell| cell.borrow()[version.index()].as_ref().map(|i| i.import_calls()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_version_loads() {
        precompile_all();
    }

    #[test]
    fn legacy_builds_only_with_their_feature() {
        for version in [EttVersion::V0680Unofficial, EttVersion::V0700] {
            assert_eq!(is_built_in(version), cfg!(feature = "legacy-builds"));
            assert_eq!(EttInstance::new(version).is_ok(), cfg!(feature = "legacy-builds"));
        }
        for version in [EttVersion::V0720, EttVersion::V0723, EttVersion::V0740, EttVersion::V0750] {
            assert!(is_built_in(version));
            assert!(EttInstance::new(version).is_ok());
        }
    }

    #[test]
    fn the_same_build_is_loaded_once() {
        assert!(std::ptr::eq(module(EttVersion::V0720), module(EttVersion::V0723)));
        assert!(!std::ptr::eq(module(EttVersion::V0723), module(EttVersion::V0740)));
    }
}
