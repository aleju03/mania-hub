const MIN_GALLOP_WINS: isize = 7;

struct State<'a, T, F: FnMut(&T, &T) -> f64> {
    cmp: &'a mut F,
    min_gallop: isize,
    runs: Vec<(isize, isize)>,
    _p: std::marker::PhantomData<T>,
}

impl<T: Clone, F: FnMut(&T, &T) -> f64> State<'_, T, F> {
    #[inline]
    fn compare(&mut self, a: &T, b: &T) -> f64 {
        let v = (self.cmp)(a, b);
        if v.is_nan() {
            0.0
        } else {
            v
        }
    }

    fn binary_insertion_sort(&mut self, w: &mut [T], low: isize, start_arg: isize, high: isize) {
        let mut start = if low == start_arg { start_arg + 1 } else { start_arg };
        while start < high {
            let mut left = low;
            let mut right = start;
            let pivot = w[right as usize].clone();
            while left < right {
                let mid = left + ((right - left) >> 1);
                let order = self.compare(&pivot, &w[mid as usize]);
                if order < 0.0 {
                    right = mid;
                } else {
                    left = mid + 1;
                }
            }
            let mut p = start;
            while p > left {
                w[p as usize] = w[(p - 1) as usize].clone();
                p -= 1;
            }
            w[left as usize] = pivot;
            start += 1;
        }
    }

    fn count_and_make_run(&mut self, w: &mut [T], low_arg: isize, high: isize) -> isize {
        let low = low_arg + 1;
        if low == high {
            return 1;
        }
        let mut run_length = 2;
        let mut order = self.compare(&w[low as usize], &w[(low - 1) as usize]);
        let is_descending = order < 0.0;
        let mut prev = low;
        let mut idx = low + 1;
        while idx < high {
            order = self.compare(&w[idx as usize], &w[prev as usize]);
            if is_descending {
                if order >= 0.0 {
                    break;
                }
            } else if order < 0.0 {
                break;
            }
            prev = idx;
            run_length += 1;
            idx += 1;
        }
        if is_descending {
            w[low_arg as usize..(low_arg + run_length) as usize].reverse();
        }
        run_length
    }

    fn gallop_left(&mut self, arr: &[T], key: &T, base: isize, length: isize, hint: isize) -> isize {
        let mut last_ofs: isize = 0;
        let mut offset: isize = 1;
        let mut order = self.compare(&arr[(base + hint) as usize], key);
        if order < 0.0 {
            let max_ofs = length - hint;
            while offset < max_ofs {
                order = self.compare(&arr[(base + hint + offset) as usize], key);
                if order >= 0.0 {
                    break;
                }
                last_ofs = offset;
                offset = (offset << 1) + 1;
                if offset <= 0 {
                    offset = max_ofs;
                }
            }
            if offset > max_ofs {
                offset = max_ofs;
            }
            last_ofs += hint;
            offset += hint;
        } else {
            let max_ofs = hint + 1;
            while offset < max_ofs {
                order = self.compare(&arr[(base + hint - offset) as usize], key);
                if order < 0.0 {
                    break;
                }
                last_ofs = offset;
                offset = (offset << 1) + 1;
                if offset <= 0 {
                    offset = max_ofs;
                }
            }
            if offset > max_ofs {
                offset = max_ofs;
            }
            let tmp = last_ofs;
            last_ofs = hint - offset;
            offset = hint - tmp;
        }
        last_ofs += 1;
        while last_ofs < offset {
            let m = last_ofs + ((offset - last_ofs) >> 1);
            order = self.compare(&arr[(base + m) as usize], key);
            if order < 0.0 {
                last_ofs = m + 1;
            } else {
                offset = m;
            }
        }
        offset
    }

    fn gallop_right(&mut self, arr: &[T], key: &T, base: isize, length: isize, hint: isize) -> isize {
        let mut last_ofs: isize = 0;
        let mut offset: isize = 1;
        let mut order = self.compare(key, &arr[(base + hint) as usize]);
        if order < 0.0 {
            let max_ofs = hint + 1;
            while offset < max_ofs {
                order = self.compare(key, &arr[(base + hint - offset) as usize]);
                if order >= 0.0 {
                    break;
                }
                last_ofs = offset;
                offset = (offset << 1) + 1;
                if offset <= 0 {
                    offset = max_ofs;
                }
            }
            if offset > max_ofs {
                offset = max_ofs;
            }
            let tmp = last_ofs;
            last_ofs = hint - offset;
            offset = hint - tmp;
        } else {
            let max_ofs = length - hint;
            while offset < max_ofs {
                order = self.compare(key, &arr[(base + hint + offset) as usize]);
                if order < 0.0 {
                    break;
                }
                last_ofs = offset;
                offset = (offset << 1) + 1;
                if offset <= 0 {
                    offset = max_ofs;
                }
            }
            if offset > max_ofs {
                offset = max_ofs;
            }
            last_ofs += hint;
            offset += hint;
        }
        last_ofs += 1;
        while last_ofs < offset {
            let m = last_ofs + ((offset - last_ofs) >> 1);
            order = self.compare(key, &arr[(base + m) as usize]);
            if order < 0.0 {
                offset = m;
            } else {
                last_ofs = m + 1;
            }
        }
        offset
    }

    fn merge_low(&mut self, w: &mut [T], base_a: isize, mut length_a: isize, base_b: isize, mut length_b: isize) {
        let temp: Vec<T> = w[base_a as usize..(base_a + length_a) as usize].to_vec();
        let mut dest = base_a;
        let mut cursor_temp: isize = 0;
        let mut cursor_b = base_b;
        w[dest as usize] = w[cursor_b as usize].clone();
        dest += 1;
        cursor_b += 1;

        enum Exit {
            Succeed,
            CopyB,
        }
        let exit: Exit = 'outer: {
            length_b -= 1;
            if length_b == 0 {
                break 'outer Exit::Succeed;
            }
            if length_a == 1 {
                break 'outer Exit::CopyB;
            }
            let mut min_gallop = self.min_gallop;
            loop {
                let mut wins_a: isize = 0;
                let mut wins_b: isize = 0;
                loop {
                    let order = self.compare(&w[cursor_b as usize], &temp[cursor_temp as usize]);
                    if order < 0.0 {
                        w[dest as usize] = w[cursor_b as usize].clone();
                        dest += 1;
                        cursor_b += 1;
                        wins_b += 1;
                        length_b -= 1;
                        wins_a = 0;
                        if length_b == 0 {
                            break 'outer Exit::Succeed;
                        }
                        if wins_b >= min_gallop {
                            break;
                        }
                    } else {
                        w[dest as usize] = temp[cursor_temp as usize].clone();
                        dest += 1;
                        cursor_temp += 1;
                        wins_a += 1;
                        length_a -= 1;
                        wins_b = 0;
                        if length_a == 1 {
                            break 'outer Exit::CopyB;
                        }
                        if wins_a >= min_gallop {
                            break;
                        }
                    }
                }
                min_gallop += 1;
                let mut first = true;
                while wins_a >= MIN_GALLOP_WINS || wins_b >= MIN_GALLOP_WINS || first {
                    first = false;
                    min_gallop = std::cmp::max(1, min_gallop - 1);
                    self.min_gallop = min_gallop;

                    let key = w[cursor_b as usize].clone();
                    wins_a = self.gallop_right(&temp, &key, cursor_temp, length_a, 0);
                    if wins_a > 0 {
                        for i in 0..wins_a {
                            w[(dest + i) as usize] = temp[(cursor_temp + i) as usize].clone();
                        }
                        dest += wins_a;
                        cursor_temp += wins_a;
                        length_a -= wins_a;
                        if length_a == 1 {
                            break 'outer Exit::CopyB;
                        }
                        if length_a == 0 {
                            break 'outer Exit::Succeed;
                        }
                    }
                    w[dest as usize] = w[cursor_b as usize].clone();
                    dest += 1;
                    cursor_b += 1;
                    length_b -= 1;
                    if length_b == 0 {
                        break 'outer Exit::Succeed;
                    }

                    let key = temp[cursor_temp as usize].clone();
                    wins_b = self.gallop_left(w, &key, cursor_b, length_b, 0);
                    if wins_b > 0 {
                        for i in 0..wins_b {
                            w[(dest + i) as usize] = w[(cursor_b + i) as usize].clone();
                        }
                        dest += wins_b;
                        cursor_b += wins_b;
                        length_b -= wins_b;
                        if length_b == 0 {
                            break 'outer Exit::Succeed;
                        }
                    }
                    w[dest as usize] = temp[cursor_temp as usize].clone();
                    dest += 1;
                    cursor_temp += 1;
                    length_a -= 1;
                    if length_a == 1 {
                        break 'outer Exit::CopyB;
                    }
                }
                min_gallop += 1;
                self.min_gallop = min_gallop;
            }
        };
        match exit {
            Exit::Succeed => {
                for i in 0..length_a {
                    w[(dest + i) as usize] = temp[(cursor_temp + i) as usize].clone();
                }
            }
            Exit::CopyB => {
                for i in 0..length_b {
                    w[(dest + i) as usize] = w[(cursor_b + i) as usize].clone();
                }
                w[(dest + length_b) as usize] = temp[cursor_temp as usize].clone();
            }
        }
    }

    fn merge_high(&mut self, w: &mut [T], base_a: isize, mut length_a: isize, base_b: isize, mut length_b: isize) {
        let temp: Vec<T> = w[base_b as usize..(base_b + length_b) as usize].to_vec();
        let mut dest = base_b + length_b - 1;
        let mut cursor_temp = length_b - 1;
        let mut cursor_a = base_a + length_a - 1;
        w[dest as usize] = w[cursor_a as usize].clone();
        dest -= 1;
        cursor_a -= 1;

        enum Exit {
            Succeed,
            CopyA,
        }
        let exit: Exit = 'outer: {
            length_a -= 1;
            if length_a == 0 {
                break 'outer Exit::Succeed;
            }
            if length_b == 1 {
                break 'outer Exit::CopyA;
            }
            let mut min_gallop = self.min_gallop;
            loop {
                let mut wins_a: isize = 0;
                let mut wins_b: isize = 0;
                loop {
                    let order = self.compare(&temp[cursor_temp as usize], &w[cursor_a as usize]);
                    if order < 0.0 {
                        w[dest as usize] = w[cursor_a as usize].clone();
                        dest -= 1;
                        cursor_a -= 1;
                        wins_a += 1;
                        length_a -= 1;
                        wins_b = 0;
                        if length_a == 0 {
                            break 'outer Exit::Succeed;
                        }
                        if wins_a >= min_gallop {
                            break;
                        }
                    } else {
                        w[dest as usize] = temp[cursor_temp as usize].clone();
                        dest -= 1;
                        cursor_temp -= 1;
                        wins_b += 1;
                        length_b -= 1;
                        wins_a = 0;
                        if length_b == 1 {
                            break 'outer Exit::CopyA;
                        }
                        if wins_b >= min_gallop {
                            break;
                        }
                    }
                }
                min_gallop += 1;
                let mut first = true;
                while wins_a >= MIN_GALLOP_WINS || wins_b >= MIN_GALLOP_WINS || first {
                    first = false;
                    min_gallop = std::cmp::max(1, min_gallop - 1);
                    self.min_gallop = min_gallop;

                    let key = temp[cursor_temp as usize].clone();
                    let k = self.gallop_right(w, &key, base_a, length_a, length_a - 1);
                    wins_a = length_a - k;
                    if wins_a > 0 {
                        dest -= wins_a;
                        cursor_a -= wins_a;
                        let mut i = wins_a - 1;
                        while i >= 0 {
                            w[(dest + 1 + i) as usize] = w[(cursor_a + 1 + i) as usize].clone();
                            i -= 1;
                        }
                        length_a -= wins_a;
                        if length_a == 0 {
                            break 'outer Exit::Succeed;
                        }
                    }
                    w[dest as usize] = temp[cursor_temp as usize].clone();
                    dest -= 1;
                    cursor_temp -= 1;
                    length_b -= 1;
                    if length_b == 1 {
                        break 'outer Exit::CopyA;
                    }

                    let key = w[cursor_a as usize].clone();
                    let k = self.gallop_left(&temp, &key, 0, length_b, length_b - 1);
                    wins_b = length_b - k;
                    if wins_b > 0 {
                        dest -= wins_b;
                        cursor_temp -= wins_b;
                        for i in 0..wins_b {
                            w[(dest + 1 + i) as usize] = temp[(cursor_temp + 1 + i) as usize].clone();
                        }
                        length_b -= wins_b;
                        if length_b == 1 {
                            break 'outer Exit::CopyA;
                        }
                        if length_b == 0 {
                            break 'outer Exit::Succeed;
                        }
                    }
                    w[dest as usize] = w[cursor_a as usize].clone();
                    dest -= 1;
                    cursor_a -= 1;
                    length_a -= 1;
                    if length_a == 0 {
                        break 'outer Exit::Succeed;
                    }
                }
                min_gallop += 1;
                self.min_gallop = min_gallop;
            }
        };
        match exit {
            Exit::Succeed => {
                if length_b > 0 {
                    let start = dest - (length_b - 1);
                    for i in 0..length_b {
                        w[(start + i) as usize] = temp[i as usize].clone();
                    }
                }
            }
            Exit::CopyA => {
                dest -= length_a;
                cursor_a -= length_a;
                let mut i = length_a - 1;
                while i >= 0 {
                    w[(dest + 1 + i) as usize] = w[(cursor_a + 1 + i) as usize].clone();
                    i -= 1;
                }
                w[dest as usize] = temp[cursor_temp as usize].clone();
            }
        }
    }

    fn merge_at(&mut self, w: &mut [T], i: usize) {
        let stack_size = self.runs.len();
        let (mut base_a, mut length_a) = self.runs[i];
        let (base_b, mut length_b) = self.runs[i + 1];
        self.runs[i].1 = length_a + length_b;
        if i == stack_size - 3 {
            self.runs[i + 1] = self.runs[i + 2];
        }
        self.runs.pop();

        let key_right = w[base_b as usize].clone();
        let k = self.gallop_right(w, &key_right, base_a, length_a, 0);
        base_a += k;
        length_a -= k;
        if length_a == 0 {
            return;
        }
        let key_left = w[(base_a + length_a - 1) as usize].clone();
        length_b = self.gallop_left(w, &key_left, base_b, length_b, length_b - 1);
        if length_b == 0 {
            return;
        }
        if length_a <= length_b {
            self.merge_low(w, base_a, length_a, base_b, length_b);
        } else {
            self.merge_high(w, base_a, length_a, base_b, length_b);
        }
    }

    fn run_invariant(&self, n: isize) -> bool {
        if n < 2 {
            return true;
        }
        let n = n as usize;
        self.runs[n - 2].1 > self.runs[n - 1].1 + self.runs[n].1
    }

    fn merge_collapse(&mut self, w: &mut [T]) {
        while self.runs.len() > 1 {
            let mut n = self.runs.len() as isize - 2;
            if !self.run_invariant(n + 1) || !self.run_invariant(n) {
                if self.runs[(n - 1) as usize].1 < self.runs[(n + 1) as usize].1 {
                    n -= 1;
                }
                self.merge_at(w, n as usize);
            } else if self.runs[n as usize].1 <= self.runs[(n + 1) as usize].1 {
                self.merge_at(w, n as usize);
            } else {
                break;
            }
        }
    }

    fn merge_force_collapse(&mut self, w: &mut [T]) {
        while self.runs.len() > 1 {
            let mut n = self.runs.len() as isize - 2;
            if n > 0 && self.runs[(n - 1) as usize].1 < self.runs[(n + 1) as usize].1 {
                n -= 1;
            }
            self.merge_at(w, n as usize);
        }
    }
}

fn min_run_length(mut n: isize) -> isize {
    let mut r = 0;
    while n >= 64 {
        r |= n & 1;
        n >>= 1;
    }
    n + r
}

pub fn js_sort_by<T: Clone, F: FnMut(&T, &T) -> f64>(w: &mut [T], mut cmp: F) {
    let length = w.len() as isize;
    if length < 2 {
        return;
    }
    let mut st = State { cmp: &mut cmp, min_gallop: MIN_GALLOP_WINS, runs: Vec::new(), _p: std::marker::PhantomData };
    let mut remaining = length;
    let mut low: isize = 0;
    let min_run = min_run_length(remaining);
    while remaining != 0 {
        let mut cur = st.count_and_make_run(w, low, low + remaining);
        if cur < min_run {
            let forced = std::cmp::min(min_run, remaining);
            st.binary_insertion_sort(w, low, low + cur, low + forced);
            cur = forced;
        }
        st.runs.push((low, cur));
        st.merge_collapse(w);
        low += cur;
        remaining -= cur;
    }
    st.merge_force_collapse(w);
}

pub fn js_sort_numbers_asc(v: &mut [f64]) {
    js_sort_by(v, |a, b| a - b);
}
