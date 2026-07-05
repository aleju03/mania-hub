import { rc4KReform } from "./4k-rc-reform.js";
import { ln4K } from "./4k-ln.js";
import { rc6K } from "./6k-rc.js";
import { ln6K } from "./6k-ln.js";
import { rc7K } from "./7k-rc.js";
import { ln7K } from "./7k-ln.js";

export const DAN_INDEX = {
    4: {
        RC: { default: rc4KReform},
        LN: { default: ln4K },
    },
    6: {
        RC: { default: rc6K },
        LN: { default: ln6K },
    },
    7: {
        RC: { default: rc7K },
        LN: { default: ln7K },
    },
};
