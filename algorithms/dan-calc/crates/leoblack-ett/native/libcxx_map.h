// An int to int map that iterates in the order emscripten's libc++
// std::unordered_map does, for wasm32: MinaCalc picks the most frequent value
// out of one, and ties go to whichever comes first, so the order changes the
// results. This follows libc++'s __hash_table: identity hash, prime bucket
// counts, max load factor 1, each new key placed first in its bucket.
#pragma once

#include <cmath>
#include <cstdint>
#include <utility>
#include <vector>

namespace mcm {

class libcxx_int_map
{
	using size = std::uint32_t; // size_t on wasm32

	struct node
	{
		int key;
		int value;
		size next; // index into nodes_, 0 for none
	};

	// nodes_[0] is the list head (libc++'s __p1_), buckets_ hold the node
	// before each bucket's first one, 0 for the head and `none` for empty
	static constexpr size none = 0xFFFFFFFFu;
	std::vector<node> nodes_{ { 0, 0, 0 } };
	std::vector<size> buckets_;
	mutable std::vector<std::pair<int, int>> ordered_;

	static auto hash(int key) -> size { return static_cast<size>(key); }

	static auto constrain(size h, size bc) -> size
	{
		return !(bc & (bc - 1)) ? h & (bc - 1) : (h < bc ? h : h % bc);
	}

	static auto is_power2(size bc) -> bool { return bc > 2 && !(bc & (bc - 1)); }

	static auto next_prime(size n) -> size
	{
		for (;; ++n) {
			if (n < 2)
				continue;
			bool prime = true;
			for (size d = 2; d * d <= n; ++d) {
				if (n % d == 0) {
					prime = false;
					break;
				}
			}
			if (prime)
				return n;
		}
	}

	void rehash(size n)
	{
		if (n == 1)
			n = 2;
		else if (n & (n - 1))
			n = next_prime(n);
		if (n <= buckets_.size())
			return;
		buckets_.assign(n, none);
		size pp = 0;
		size cp = nodes_[pp].next;
		if (cp == 0)
			return;
		size phash = constrain(hash(nodes_[cp].key), n);
		buckets_[phash] = pp;
		for (pp = cp, cp = nodes_[cp].next; cp != 0; cp = nodes_[pp].next) {
			const size chash = constrain(hash(nodes_[cp].key), n);
			if (chash == phash) {
				pp = cp;
			} else if (buckets_[chash] == none) {
				buckets_[chash] = pp;
				pp = cp;
				phash = chash;
			} else {
				nodes_[pp].next = nodes_[cp].next;
				nodes_[cp].next = nodes_[buckets_[chash]].next;
				nodes_[buckets_[chash]].next = cp;
			}
		}
	}

  public:
	auto operator[](int key) -> int&
	{
		ordered_.clear();
		const size h = hash(key);
		size bc = static_cast<size>(buckets_.size());
		size chash = 0;
		if (bc != 0) {
			chash = constrain(h, bc);
			size nd = buckets_[chash];
			if (nd != none) {
				for (nd = nodes_[nd].next;
					 nd != 0 && (hash(nodes_[nd].key) == h ||
								  constrain(hash(nodes_[nd].key), bc) == chash);
					 nd = nodes_[nd].next) {
					if (nodes_[nd].key == key)
						return nodes_[nd].value;
				}
			}
		}
		const size count = static_cast<size>(nodes_.size() - 1);
		if (count + 1 > bc || bc == 0) {
			rehash(std::max<size>(2 * bc + !is_power2(bc),
								  static_cast<size>(std::ceil(static_cast<float>(count + 1)))));
			bc = static_cast<size>(buckets_.size());
			chash = constrain(h, bc);
		}
		const size added = static_cast<size>(nodes_.size());
		nodes_.push_back({ key, 0, 0 });
		size pn = buckets_[chash];
		if (pn == none) {
			pn = 0;
			nodes_[added].next = nodes_[pn].next;
			nodes_[pn].next = added;
			buckets_[chash] = pn;
			if (nodes_[added].next != 0)
				buckets_[constrain(hash(nodes_[nodes_[added].next].key), bc)] = added;
		} else {
			nodes_[added].next = nodes_[pn].next;
			nodes_[pn].next = added;
		}
		return nodes_[added].value;
	}

	auto begin() const
	{
		if (ordered_.empty())
			for (size n = nodes_[0].next; n != 0; n = nodes_[n].next)
				ordered_.emplace_back(nodes_[n].key, nodes_[n].value);
		return ordered_.cbegin();
	}

	auto end() const
	{
		begin();
		return ordered_.cend();
	}
};

}
