import { describe, expect, it } from "vitest";
import { getMapsPageviewProperties } from "./analytics-maps";

function props(search: string) {
  return getMapsPageviewProperties(new URLSearchParams(search));
}

describe("getMapsPageviewProperties", () => {
  it("treats a bare /maps as the default search tab with nothing set", () => {
    expect(props("")).toEqual({ maps_tab: "search" });
  });

  it("reports the search query and the facets behind it", () => {
    const result = props("sQ=camellia&sKeys=7k&sStatuses=ranked,loved&sStarMin=4.5&sStarMax=6&sPatterns=jack,chordjack");
    expect(result.maps_tab).toBe("search");
    expect(result.maps_query).toBe("camellia");
    expect(result.maps_filters).toBe("7K · ranked/loved · 4.5-6★ · Jack/Chordjack");
  });

  it("formats open-ended bpm and length ranges", () => {
    expect(props("sBpmMin=180").maps_filters).toBe("180 bpm+");
    expect(props("sLenMax=120").maps_filters).toBe("up to 2:00");
  });

  it("names dan levels on the ladder the key and pattern facets select", () => {
    // 4K reform: 13 is a greek course; 7K: 12 is a boss course.
    expect(props("sKeys=4k&sDanMin=13").maps_filters).toBe("4K · dan Gamma+");
    expect(props("sKeys=7k&sDanMin=0&sDanMax=12").maps_filters).toBe("7K · dan 0-Azimuth");
    // A dan floor of 0 is a real 7K pick, not an absent filter.
    expect(props("sKeys=7k&sDanMin=0").maps_filters).toBe("7K · dan 0+");
  });

  it("reports sort only when it is off the default", () => {
    expect(props("sSort=stars&sDir=asc").maps_sort).toBe("difficulty asc");
    expect(props("").maps_sort).toBeUndefined();
    expect(props("tab=farmed&dir=asc").maps_sort).toBe("players asc");
  });

  it("reads the country lenses' own filters", () => {
    const result = props("tab=farmed&q=liquid&key=4k&mod=dt&pp=8000&farmedSort=max-pp");
    expect(result.maps_tab).toBe("farmed");
    expect(result.maps_query).toBe("liquid");
    expect(result.maps_filters).toBe("4K · DT · 8000pp+ players");
    expect(result.maps_sort).toBe("max pp");
  });

  it("falls back to the collection id when no tile stashed its name", () => {
    expect(props("tab=collections&col=abc123").maps_collection).toBe("#abc123");
  });

  it("reports the human page number and an opened map", () => {
    const result = props("page=2&map=1234567");
    expect(result.maps_page).toBe(3);
    expect(result.maps_beatmap_id).toBe("1234567");
  });
});
