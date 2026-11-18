//! MinaCalc built from Etterna's C++ (`native/`), for the `native` feature.
//!
//! The sources are Etterna's at each version's tag, changed only where marked
//! `dan-calc`, so they give what the site's wasm builds give: the skill cap at
//! 100, `fastsqrt` as an exact square root, and nothing kept between runs.

use crate::versions::EttVersion;

type Compute = unsafe extern "C" fn(i32, f32, f32, *const u32, *const f32, i32, *mut f32) -> i32;

extern "C" {
    fn minacalc_0723_compute(keycount: i32, rate: f32, goal: f32, masks: *const u32, times: *const f32, rows: i32, out: *mut f32) -> i32;
    fn minacalc_0740_compute(keycount: i32, rate: f32, goal: f32, masks: *const u32, times: *const f32, rows: i32, out: *mut f32) -> i32;
    fn minacalc_0750_compute(keycount: i32, rate: f32, goal: f32, masks: *const u32, times: *const f32, rows: i32, out: *mut f32) -> i32;
}

fn compute(version: EttVersion) -> Option<Compute> {
    match version {
        EttVersion::V0720 | EttVersion::V0723 => Some(minacalc_0723_compute),
        EttVersion::V0740 => Some(minacalc_0740_compute),
        EttVersion::V0750 => Some(minacalc_0750_compute),
        EttVersion::V0680Unofficial | EttVersion::V0700 => None,
    }
}

pub fn is_built_in(version: EttVersion) -> bool {
    compute(version).is_some()
}

/// The 8 values in MinaCalc's own order (`OFFICIAL_OUTPUT_ORDER`).
pub fn run(version: EttVersion, keycount: i32, rate: f64, goal: f64, masks: &[u32], times: &[f32]) -> Result<[f32; 8], String> {
    let Some(compute) = compute(version) else {
        return Err(format!("MinaCalc {} is not built in natively", version.key()));
    };
    let rows = masks.len().min(times.len());
    let rows = i32::try_from(rows).map_err(|_| format!("{rows} rows is too many for MinaCalc"))?;
    let mut out = [0f32; 8];
    // SAFETY: both slices hold `rows` items and `out` has room for the 8 it writes.
    let ok = unsafe { compute(keycount, rate as f32, goal as f32, masks.as_ptr(), times.as_ptr(), rows, out.as_mut_ptr()) };
    if ok == 0 {
        return Err("minacalc_compute returned failure".into());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    // jumpstream with a jack every so often, for every skillset to have something
    fn rows(keycount: u32) -> (Vec<u32>, Vec<f32>) {
        let full = (1u32 << keycount) - 1;
        (0..1200u32)
            .map(|i| {
                let mask = match i % 7 {
                    0 => 0b1 | 0b100,
                    3 => full & 0b1010,
                    5 => 0b1,
                    _ => 1 << (i % keycount),
                };
                (mask, i as f32 * 0.09)
            })
            .unzip()
    }

    #[test]
    fn runs_alike_every_time() {
        for (version, keycount) in [(EttVersion::V0723, 4), (EttVersion::V0740, 4), (EttVersion::V0750, 4), (EttVersion::V0750, 7)] {
            let (masks, times) = rows(keycount);
            let first = run(version, keycount as i32, 1.0, 0.93, &masks, &times).unwrap();
            assert!(first.iter().all(|v| v.is_finite()) && first[0] > 5.0, "{} {keycount}K: {first:?}", version.key());
            let again: Vec<_> = (0..4)
                .map(|_| {
                    let (masks, times) = (masks.clone(), times.clone());
                    std::thread::spawn(move || run(version, keycount as i32, 1.0, 0.93, &masks, &times).unwrap())
                })
                .collect();
            for t in again {
                assert_eq!(t.join().unwrap().map(f32::to_bits), first.map(f32::to_bits));
            }
        }
        assert!(run(EttVersion::V0700, 4, 1.0, 0.93, &[1, 2], &[0.0, 0.1]).is_err());
    }
}
