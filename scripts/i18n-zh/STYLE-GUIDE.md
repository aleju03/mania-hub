# zh-CN translation style guide (mania-tracker.com)

Voice: a native osu!mania player writing UI copy in Simplified Chinese. Must read natural to mainland Chinese osu! players, never like machine translation.

## Glossary (mandatory, keep exactly consistent; matches the po header)

Aligned with the community reference https://github.com/inuiyumegan/vsrg-en-to-zh-localization-reference (2026-10-15 pass). Where this list and the reference differ, the difference is deliberate and noted here.
- pp / PP -> pp (unchanged) | star rating / SR -> 星级 | beatmap / map -> 谱面
- mapper -> 谱师 | keymode / keys -> 键数 (4K/7K stay as-is) | ranked -> 上架 | pending -> 待定 | loved -> 社区喜爱 | qualified -> 过审 | graveyard -> 坟场
- snipe -> 狙击 | top plays -> 最佳成绩 | tracker -> 追踪器 | farm -> 刷图 (activity) / 刷分 (score push)
- FC -> FC (never 全连) | choke -> 断连 ("FC 断连") | replay -> 回放
- skin -> 皮肤 | pack / packs (card packs) -> 卡包 | collections (card binder) -> 收藏册 | collections (map lists) -> 收藏夹 | album (card album) -> 卡册 (never 专辑)
- favourites -> 收藏 | play count -> 游玩次数 | accuracy -> 准确率 | leaderboard / rankings -> 排行榜
- score -> 成绩 (a play) / 分数 (the number) | mods -> 模组 (DT/HT/MR and mod names stay as-is) | rate -> 倍速, and a rate number takes it too: 1.3x -> 1.3倍速 (never 速率, and never 变速, which means SV) | grades (SS/S/A) stay as-is
- dan / dan course -> 段位 (never 课程, 课题, 段位课程) | ladder -> 段位表 | stamina -> 耐力 | tech -> 技, technical -> 技巧 (kept apart because LN Tech and LN Technical are both pattern tags) | skillset -> 技能组 | skill rating -> 技能评分 | overall -> 总体 (general -> 综合)
- hit window -> 判定区间 | hit error bar -> 偏移条 | scroll speed -> 流速 | lane cover -> 挡板 | release (LN) -> 放手 | vibro -> 秒杀
- Pattern labels follow the reference: stream -> 乱键 | single-note stream -> 单乱 | jack -> 叠键 | chordjack -> 大叠 | chordstream -> 胶囊 | speedjack -> 速叠 | trill -> 交互 (never for streams) | minijack -> 子弹 | handjack -> 三押叠 | jumpstream -> 双押切 | handstream -> 三押切 | quadstream -> 四押切 | dumpstream -> 塞爆 | bracket -> 衩 | roll -> 楼梯 | jumptrill -> 对拍 | inverse -> 反键 | LN walls -> LN 墙 (never 和弦 for chords; that means musical chords)
- The speed skill stays 速度, not the reference's 乱键: the same "Speed" label also names the LN speed skill, and stream already takes 乱键
- LN stays LN wherever the English says LN (LN 段位, LN 技巧, 4K LN); long note / hold in prose -> 长条 | rice / regular -> 单点 (never 常规 or 普通)
- country/region -> always 国家/地区 (never 国家 alone)
- goal -> 目标 | streak (higher/lower game) -> 连胜 | card -> 卡片 | shard -> 碎片
- community -> 社区 | Discord terms (server, channel, command names like /track) stay English
- playfield -> 游玩区域 | stage (skin element) -> 面板 | pattern -> 键型 (never 谱型 or 型态) | play session -> 场 (游玩场次) | bars note style -> 条形 (never 长条, that means LN) | other players take 该玩家/其, never 他
- Quotes are always 「」, never “”

## Hard rules
1. Preserve ICU/markup EXACTLY: {0}, {name}, {count, plural, ...}, tags <0></0>, <1/>. Every placeholder/tag appears exactly once; reordering is fine and encouraged.
2. Plurals: zh has one form. Keep the ICU wrapper, collapse to only the `other` branch: `{count, plural, other {共 # 个谱面}}`. `#` renders the number.
3. Chinese punctuation in prose (，。：？！、). NO em dashes anywhere.
4. Space between CJK and Latin/numbers: "共 3 个", "pp 排行", "{0} 名玩家".
5. Usernames, map/song titles, skin names, mod acronyms, "osu!"/"osu!mania" stay untranslated.
6. Concise UI register: buttons terse (上传, 复制链接), sentences natural; rewrite as a Chinese UI would say it, never word-by-word.
7. Format scaffolding keeps its shape: " · updated {0}" -> " · 更新于 {0}".
8. Ordinals -> 第 {n} 名 / 第N.

## Workflow
1. `node scripts/i18n-zh/dump-untranslated.mjs` -> chunk JSONs in scripts/i18n-zh/zh-chunks/
2. Translate each chunk to `{ "<msgid>": "<zh>" }` JSON files in scripts/i18n-zh/zh-out/
3. `node scripts/i18n-zh/merge-zh.mjs scripts/i18n-zh/zh-out/*.json`
4. `npm run i18n:extract` (normalizes po folding, keeps translations), `npm run i18n:compile`
5. Tests + commit. Whole draft is machine-made pending donor/community review.
