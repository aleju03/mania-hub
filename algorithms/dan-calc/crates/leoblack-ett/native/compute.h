// The C function a version's file defines: MC_NS and MC_COMPUTE name its
// namespace and the function, MC_KEYCOUNT says its MinaSDCalc takes one.

extern "C" int
MC_COMPUTE(int keycount, float rate, float goal, const std::uint32_t* masks, const float* times, int rows, float* out)
{
	try {
		std::vector<MC_NS::NoteInfo> notes(static_cast<std::size_t>(rows));
		for (int i = 0; i < rows; i++)
			notes[i] = { masks[i], times[i] };

		// zeroed, as the wasm builds' memory is before every run
		void* place = std::calloc(1, sizeof(MC_NS::Calc));
		if (place == nullptr)
			return 0;
		auto* calc = new (place) MC_NS::Calc();
#if MC_KEYCOUNT
		const auto ssr = MC_NS::MinaSDCalc(notes, rate, goal, static_cast<unsigned>(keycount), calc);
#else
		(void)keycount;
		const auto ssr = MC_NS::MinaSDCalc(notes, rate, goal, calc);
#endif
		calc->~Calc();
		std::free(place);

		if (ssr.size() < 8)
			return 0;
		for (int i = 0; i < 8; i++)
			out[i] = ssr[i];
		return 1;
	} catch (...) {
		return 0;
	}
}
