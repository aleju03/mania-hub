# osu! API v2 - Read Endpoints Reference

> Base URL: `https://osu.ppy.sh/api/v2`
>
> Authentication: OAuth2 Bearer Token (Client Credentials for public data, Authorization Code for user-specific data)
>
> This document covers **all GET (read-only) endpoints** available in the osu! API v2, plus the legacy v1 API.

---

## Table of Contents

1. [Beatmaps](#1-beatmaps)
2. [Beatmapsets](#2-beatmapsets)
3. [Beatmap Packs](#3-beatmap-packs)
4. [Scores](#4-scores)
5. [Users](#5-users)
6. [Rankings](#6-rankings)
7. [Multiplayer / Rooms](#7-multiplayer--rooms)
8. [Matches (Legacy Multiplayer)](#8-matches-legacy-multiplayer)
9. [Beatmapset Discussions (Modding)](#9-beatmapset-discussions-modding)
10. [Comments](#10-comments)
11. [Changelog](#11-changelog)
12. [News](#12-news)
13. [Search](#13-search)
14. [Events](#14-events)
15. [Forum](#15-forum)
16. [Chat](#16-chat)
17. [Friends & Blocks](#17-friends--blocks)
18. [Notifications](#18-notifications)
19. [Wiki](#19-wiki)
20. [Spotlights](#20-spotlights)
21. [Seasonal Backgrounds](#21-seasonal-backgrounds)
22. [Tags](#22-tags)
23. [Teams](#23-teams)
24. [Account / Me](#24-account--me)
25. [Key Data Models](#25-key-data-models)
26. [Legacy API v1](#26-legacy-api-v1)

---

## 1. Beatmaps

### `GET /beatmaps`
Get multiple beatmaps by ID.

| Param | Type | Description |
|-------|------|-------------|
| `ids[]` | int[] | Up to 50 beatmap IDs |

**Returns:** Array of `BeatmapExtended` objects.

**Key fields:** `id`, `beatmapset_id`, `difficulty_rating`, `mode`, `status`, `total_length`, `user_id`, `version`, `accuracy` (OD), `ar`, `bpm`, `convert`, `count_circles`, `count_sliders`, `count_spinners`, `cs`, `drain` (HP), `hit_length`, `is_scoreable`, `last_updated`, `mode_int`, `passcount`, `playcount`, `ranked`, `url`, `checksum`

**Includes:** `beatmapset` (with ratings), `failtimes`, `max_combo`, `owners`, `current_user_playcount`

---

### `GET /beatmaps/{beatmap}`
Get a single beatmap by ID.

**Returns:** `BeatmapExtended` with `beatmapset` (incl. ratings), `failtimes`, `max_combo`, `owners`

---

### `GET /beatmaps/lookup`
Look up a beatmap by checksum, filename, or ID.

| Param | Type | Description |
|-------|------|-------------|
| `checksum` | string | MD5 checksum of the .osu file |
| `filename` | string | Filename of the .osu file |
| `id` | int | Beatmap ID |

**Returns:** Same as Get Beatmap.

---

### `POST /beatmaps/{beatmap}/attributes`
Calculate difficulty attributes for a beatmap. (POST but read-only in nature.)

| Param | Type | Description |
|-------|------|-------------|
| `mods` | int/string[]/object[] | Mod bitset, acronym array, or mod objects |
| `ruleset` | string | Ruleset name (osu, taiko, fruits, mania) |
| `ruleset_id` | int | Ruleset ID (0-3) |

**Returns:** `DifficultyAttributes` -- `max_combo`, `star_rating`, plus mode-specific fields (`aim_difficulty`, `speed_difficulty`, `flashlight_difficulty`, `slider_factor`, `speed_note_count`, `overall_difficulty`, `approach_rate`, etc.)

---

### `GET /beatmaps/{beatmap}/scores`
Get scores on a beatmap.

| Param | Type | Description |
|-------|------|-------------|
| `legacy_only` | bool | Only return legacy scores |
| `mode` | string | Ruleset filter |
| `mods[]` | string[] | Filter by mod acronyms |
| `type` | string | Leaderboard type: `global`, `country`, `friend` |

**Returns:** `{ score_count, scores[], user_score }` -- each score includes `user`, `user.country`, `user.cover`, `user.team`

---

### `GET /beatmaps/{beatmap}/scores/users/{user}`
Get a user's best score on a beatmap.

| Param | Type | Description |
|-------|------|-------------|
| `legacy_only` | bool | Only return legacy scores |
| `mode` | string | Ruleset filter |
| `mods[]` | string[] | Filter by mod acronyms |

**Returns:** `{ position, score }` -- score includes `beatmap.owners`, `user`, `user.country`, `user.cover`, `user.team`

---

### `GET /beatmaps/{beatmap}/scores/users/{user}/all`
Get all of a user's scores on a beatmap.

| Param | Type | Description |
|-------|------|-------------|
| `legacy_only` | bool | Only return legacy scores |
| `ruleset` | string | Ruleset filter |

**Returns:** `{ scores: Score[] }`

---

## 2. Beatmapsets

### `GET /beatmapsets/{beatmapset}`
Get a beatmapset by ID.

**Returns:** `BeatmapsetExtended` with extensive includes:
- `beatmaps` (with `failtimes`, `owners`, `top_tag_ids`, `max_combo`, `current_user_playcount`, `current_user_tag_ids`)
- `converts`, `current_nominations`, `current_user_attributes`
- `description`, `genre`, `language`, `pack_tags`, `ratings`
- `recent_favourites`, `related_tags`, `related_users`
- `user`, `version_count`

**Key fields:** `id`, `artist`, `creator`, `favourite_count`, `hype`, `nsfw`, `play_count`, `preview_url`, `source`, `status`, `title`, `user_id`, `video`, `bpm`, `ranked_date`, `submitted_date`, `tags`

---

### `GET /beatmapsets/lookup`
Look up a beatmapset by one of its beatmap IDs.

| Param | Type | Description |
|-------|------|-------------|
| `beatmap_id` | int | A beatmap ID contained in the set |

**Returns:** Same as Get Beatmapset.

---

### `GET /beatmapsets/search`
Search for beatmapsets (powers the in-game and web beatmap listing).

| Param | Type | Description |
|-------|------|-------------|
| `q` | string | Search query |
| `m` | int | Mode (0=osu, 1=taiko, 2=catch, 3=mania) |
| `s` | string | Status: `ranked`, `qualified`, `loved`, `pending`, `graveyard`, `any` |
| `g` | int | Genre ID |
| `l` | int | Language ID |
| `sort` | string | Sort field + direction (e.g. `ranked_desc`) |
| `nsfw` | bool | Include NSFW |
| `played` | string | `played` or `unplayed` (requires auth) |
| `r` | int | Rank achieved filter |
| `c` | string | General: `converts`, `follows`, `featured_artists`, `spotlights` |
| `e` | string | Extra: `video`, `storyboard` |
| `cursor_string` | string | Pagination cursor |

**Returns:** `{ beatmapsets[], search, recommended_difficulty, total, cursor_string }`

---

## 3. Beatmap Packs

### `GET /beatmaps/packs`
List beatmap packs.

| Param | Type | Description |
|-------|------|-------------|
| `type` | string | `standard`, `featured`, `tournament`, `loved`, `chart`, `theme`, `artist` |

**Returns:** `{ beatmap_packs: BeatmapPack[], cursor_string }`

---

### `GET /beatmaps/packs/{pack}`
Get a specific beatmap pack.

| Param | Type | Description |
|-------|------|-------------|
| `legacy_only` | bool | For user completion data |

**Returns:** `BeatmapPack` with `beatmapsets[]` and `user_completion_data`

**Key fields:** `tag`, `name`, `url`, `author`, `date`

---

## 4. Scores

### `GET /scores`
Get up to 1000 recent passed scores globally.

| Param | Type | Description |
|-------|------|-------------|
| `ruleset` | string | Filter by ruleset |
| `cursor_string` | string | Pagination cursor |

**Returns:** Array of scores ordered oldest-to-latest with `cursor_string`.

---

### `GET /scores/{score}`
Get a single score by ID.

**Returns:** Score with `beatmap` (max_combo, user, owners), `beatmapset`, `rank_global`, and user card fields.

---

### `GET /scores/{ruleset}/{score}`
Get a score using legacy score ID lookup.

**Returns:** Same as above.

---

### `GET /scores/{score}/download`
Download a replay file.

**Returns:** Binary `.osr` replay file.

---

## 5. Users

### `GET /users/{user}/{mode?}`
Get a user's profile. Prefix username with `@` to look up by name instead of ID.

| Param | Type | Description |
|-------|------|-------------|
| `key` | string | `id` or `username` (deprecated -- use `@` prefix) |

**Returns:** `UserExtended` with full profile data including:

- **Profile info:** `avatar_url`, `country_code`, `cover_url`, `discord`, `interests`, `join_date`, `location`, `occupation`, `playmode`, `playstyle`, `title`, `twitter`, `website`
- **Counts:** `favourite_beatmapset_count`, `follower_count`, `graveyard_beatmapset_count`, `loved_beatmapset_count`, `mapping_follower_count`, `pending_beatmapset_count`, `ranked_beatmapset_count`, `post_count`, `beatmap_playcounts_count`, `scores_best_count`, `scores_first_count`, `scores_recent_count`
- **History:** `account_history`, `badges`, `groups`, `monthly_playcounts`, `previous_usernames`, `rank_highest`, `rank_history`, `replays_watched_counts`, `user_achievements`
- **Statistics:** `statistics` (with `country_rank`, `global_rank`, `pp`, `ranked_score`, `hit_accuracy`, `play_count`, `play_time`, `total_score`, `total_hits`, `maximum_combo`, `grade_counts`, `level`, `variants`)
- **Flags:** `is_active`, `is_bot`, `is_deleted`, `is_online`, `is_supporter`, `has_supported`
- **Other:** `support_level`, `profile_hue`, `profile_order`, `active_tournament_banner`, `daily_challenge_user_stats`

---

### `GET /me/{mode?}`
Get the authenticated user's own profile.

**Scope:** `identify`

**Returns:** Same as Get User plus `session_verified` and `statistics_rulesets` (stats for all 4 rulesets).

---

### `GET /users`
Get multiple users by ID.

| Param | Type | Description |
|-------|------|-------------|
| `ids[]` | int[] | Up to 50 user IDs |
| `include_variant_statistics` | bool | Include mania key variant stats |

**Returns:** `{ users: User[] }` with `country`, `cover`, `groups`, `statistics_rulesets`

---

### `GET /users/lookup`
Look up users by ID or username.

| Param | Type | Description |
|-------|------|-------------|
| `ids[]` | string[] | Up to 50 (numeric IDs or `@username`) |
| `exclude_bots` | bool | Exclude bot accounts |
| `ruleset_id` | int | Include global rank for this ruleset |

**Returns:** `{ users: User[] }` with `country`, `cover`, `groups`, `team`, optionally `global_rank`

---

### `GET /users/{user}/scores/{type}`
Get a user's scores.

| Type | Description |
|------|-------------|
| `best` | Top performance scores (includes `weight` for pp) |
| `firsts` | #1 scores on leaderboards |
| `recent` | Recently played (includes fails if `include_fails=1`) |
| `pinned` | User-pinned scores |

| Param | Type | Description |
|-------|------|-------------|
| `legacy_only` | bool | Only return legacy scores |
| `include_fails` | bool | Include failed scores (for `recent`) |
| `mode` | string | Ruleset filter |
| `limit` | int | Number of results |
| `offset` | int | Pagination offset |

**Returns:** Array of Score objects with `beatmap`, `beatmapset`. `best` type also includes `weight`.

---

### `GET /users/{user}/beatmapsets/{type}`
Get a user's beatmapsets.

| Type | Description |
|------|-------------|
| `favourite` | Favourited beatmapsets |
| `graveyard` | Graveyarded maps |
| `guest` | Guest difficulties |
| `loved` | Loved maps |
| `most_played` | Most played beatmaps (returns `BeatmapPlaycount`) |
| `nominated` | Nominated maps |
| `ranked` | Ranked maps |
| `pending` | Pending/WIP maps |

| Param | Type | Description |
|-------|------|-------------|
| `limit` | int | Number of results |
| `offset` | int | Pagination offset |

---

### `GET /users/{user}/kudosu`
Get a user's kudosu history.

| Param | Type | Description |
|-------|------|-------------|
| `limit` | int | Number of results |
| `offset` | int | Pagination offset |

**Returns:** Array of `KudosuHistory` objects.

---

### `GET /users/{user}/recent_activity`
Get a user's recent activity/events.

| Param | Type | Description |
|-------|------|-------------|
| `limit` | int | Number of results |
| `offset` | int | Pagination offset |

**Returns:** Array of `Event` objects.

---

### `GET /users/{user}/beatmaps-passed`
Get beatmaps a user has passed within specific beatmapsets.

| Param | Type | Description |
|-------|------|-------------|
| `beatmapset_ids[]` | int[] | Up to 50 beatmapset IDs |
| `exclude_converts` | bool | Exclude converted maps |
| `is_legacy` | bool | Legacy scores only |
| `no_diff_reduction` | bool | Exclude diff-reduction mods |
| `ruleset_id` | int | Ruleset filter |

**Returns:** `{ beatmaps_passed: Beatmap[] }`

---

## 6. Rankings

### `GET /rankings/{mode}/{type}`
Get global rankings.

**Modes:** `osu`, `taiko`, `fruits`, `mania`

| Type | Description |
|------|-------------|
| `global` | Global performance/score rankings |
| `country` | Country rankings |
| `charts` | Spotlight rankings |
| `team` | Team rankings |

| Param | Type | Description |
|-------|------|-------------|
| `country` | string | Country code filter (for `global`) |
| `cursor` | string | Pagination cursor |
| `filter` | string | `all` or `friends` |
| `spotlight` | int | Spotlight ID (for `charts`) |
| `variant` | string | `4k` or `7k` (for mania) |
| `sort` | string | `performance` or `score` (for global/team) |

**Returns for `global`:** `{ ranking: UserStatistics[], total, cursor_string }` -- each entry includes `user`, `country`, `cover`, `team`

**Returns for `country`:** `{ ranking: CountryStatistics[] }` -- each with `country` object

**Returns for `team`:** `{ ranking: TeamStatistics[] }` -- each with `team`, `member_count`

**Returns for `charts`:** `{ ranking: UserStatistics[], beatmapsets[], spotlight }` -- spotlight includes `participant_count`

---

### `GET /rankings/kudosu`
Get kudosu rankings.

| Param | Type | Description |
|-------|------|-------------|
| `page` | int | Page number |

**Returns:** `{ ranking: User[] }` with `kudosu` field.

---

## 7. Multiplayer / Rooms

### `GET /rooms`
List multiplayer rooms.

| Param | Type | Description |
|-------|------|-------------|
| `limit` | int | Number of results |
| `mode` | string | `active`, `all`, `ended`, `participated`, `owned` |
| `season_id` | int | Filter by season |
| `sort` | string | `ended` or `created` |
| `type_group` | string | `playlists` or `realtime` |

**Returns:** Array of Room objects with `current_playlist_item.beatmap.beatmapset`, `difficulty_range`, `host.country`, `playlist_item_stats`, `recent_participants`

---

### `GET /rooms/{room}`
Get a specific room's details.

**Returns:** Full Room object.

---

### `GET /rooms/{room}/leaderboard`
Get a room's leaderboard.

| Param | Type | Description |
|-------|------|-------------|
| `limit` | int | Number of results |

**Returns:** `{ leaderboard: UserScoreAggregate[], user_score }` with `user.country`

---

### `GET /rooms/{room}/events`
Get room events (for realtime rooms).

| Param | Type | Description |
|-------|------|-------------|
| `limit` | int | Number of events |
| `after` | int | Events after this ID |
| `before` | int | Events before this ID |

**Returns:** `{ beatmaps[], beatmapsets[], events[], playlist_items[], room, users[], first_event_id, last_event_id, current_playlist_item_id }`

---

### `GET /rooms/{room}/playlist/{playlist}/scores`
Get scores on a playlist item.

| Param | Type | Description |
|-------|------|-------------|
| `limit` | int | Number of results |
| `sort` | string | Sort order |
| `cursor_string` | string | Pagination cursor |

**Returns:** `{ scores[], total, user_score, params, cursor_string }`

---

### `GET /rooms/{room}/playlist/{playlist}/scores/{score}`
Get a specific score on a playlist item.

**Returns:** Score with `position` and `scores_around`.

---

### `GET /rooms/{room}/playlist/{playlist}/scores/users/{user}`
Get a user's highest score on a playlist item.

**Returns:** Score with `position` and `scores_around`.

---

## 8. Matches (Legacy Multiplayer)

### `GET /matches`
List legacy multiplayer matches.

| Param | Type | Description |
|-------|------|-------------|
| `limit` | int | 1-50 |
| `sort` | string | `id_desc` or `id_asc` |
| `active` | bool | Filter active matches |

**Returns:** `{ matches: Match[], params, cursor, cursor_string }`

**Match fields:** `id`, `start_time`, `end_time`, `name`

---

### `GET /matches/{match}`
Get a specific match with events.

| Param | Type | Description |
|-------|------|-------------|
| `before` | int | Events before this ID |
| `after` | int | Events after this ID |
| `limit` | int | 1-101 |

**Returns:** `{ match, events: MatchEvent[], users: User[], first_event_id, latest_event_id, current_game_id }`

Events include `game` (with `beatmap.beatmapset`, `scores`).

---

## 9. Beatmapset Discussions (Modding)

### `GET /beatmapsets/discussions`
Get modding discussions.

| Param | Type | Description |
|-------|------|-------------|
| `beatmap_id` | int | Filter by beatmap |
| `beatmapset_id` | int | Filter by beatmapset |
| `beatmapset_status` | string | `all`, `ranked`, `qualified`, `disqualified`, `never_qualified` |
| `limit` | int | Number of results |
| `message_types[]` | string[] | `suggestion`, `problem`, `mapper_note`, `praise`, `hype`, `review` |
| `only_unresolved` | bool | Only unresolved discussions |
| `page` | int | Page number |
| `sort` | string | `id_desc` or `id_asc` |
| `user` | int | Filter by user ID |

**Returns:** `{ discussions[], included_discussions[], beatmaps[], users[], reviews_config, cursor_string }`

---

### `GET /beatmapsets/discussions/posts`
Get discussion posts.

| Param | Type | Description |
|-------|------|-------------|
| `beatmapset_discussion_id` | int | Filter by discussion |
| `limit` | int | Number of results |
| `page` | int | Page number |
| `sort` | string | Sort order |
| `types[]` | string[] | `first`, `reply`, `system` |
| `user` | int | Filter by user ID |
| `with_deleted` | string | Include deleted posts |

**Returns:** `{ beatmapsets, posts: BeatmapsetDiscussionPost[], users, cursor_string }`

---

### `GET /beatmapsets/discussions/votes`
Get discussion votes.

| Param | Type | Description |
|-------|------|-------------|
| `beatmapset_discussion_id` | int | Filter by discussion |
| `limit` | int | Number of results |
| `page` | int | Page number |
| `receiver` | int | Filter by vote receiver |
| `score` | int | `1` (upvote) or `-1` (downvote) |
| `sort` | string | Sort order |
| `user` | int | Filter by voter |
| `with_deleted` | string | Include deleted |

**Returns:** `{ discussions, users, votes: BeatmapsetDiscussionVote[], cursor_string }`

---

### `GET /beatmapsets/events`
Get beatmapset modding events (nominations, disqualifications, etc.).

**Returns:** Beatmapset events with metadata.

---

## 10. Comments

### `GET /comments`
Get comments on beatmapsets, news posts, or builds.

| Param | Type | Description |
|-------|------|-------------|
| `after` | int | Comments after this ID |
| `commentable_type` | string | `beatmapset`, `news_post`, `build` |
| `commentable_id` | int | ID of the commentable |
| `cursor` | string | Pagination cursor |
| `parent_id` | int | Parent comment ID (0 for top-level) |
| `sort` | string | `new`, `old`, `top` |
| `user_id` | int | Filter by user |

**Returns:** `{ comments[], included_comments[], pinned_comments[], users[], has_more, total, top_level_count, cursor_string }`

---

### `GET /comments/{comment}`
Get a specific comment with replies (up to 2 levels deep).

**Returns:** `CommentBundle`

---

## 11. Changelog

### `GET /changelog`
List changelog builds.

| Param | Type | Description |
|-------|------|-------------|
| `from` | string | Minimum version |
| `max_id` | int | Maximum build ID |
| `stream` | string | Stream name filter |
| `to` | string | Maximum version |
| `message_formats[]` | string[] | `html`, `markdown` |

**Returns:** `{ builds: Build[], streams: UpdateStream[], search }`

Streams include `latest_build` and `user_count`.
Builds include `changelog_entries` with `github_user`.

---

### `GET /changelog/{changelog}`
Get a specific build.

| Param | Type | Description |
|-------|------|-------------|
| `key` | string | Unset for version/stream, `id` for build ID |
| `message_formats[]` | string[] | `html`, `markdown` |

**Returns:** Build with `changelog_entries`, `github_user`, `versions` (previous/next).

---

### `GET /changelog/{stream}/{build}`
Get a build by stream name and version string.

**Returns:** Same as above.

---

## 12. News

### `GET /news`
List news posts.

| Param | Type | Description |
|-------|------|-------------|
| `limit` | int | 1-21 (default 12) |
| `year` | int | Filter by year |
| `cursor_string` | string | Pagination cursor |

**Returns:** `{ news_posts: NewsPost[], news_sidebar, search, cursor_string }`

**NewsPost fields:** `id`, `author`, `edit_url`, `first_image`, `published_at`, `updated_at`, `slug`, `title`, `preview`

---

### `GET /news/{news}`
Get a specific news post.

| Param | Type | Description |
|-------|------|-------------|
| `key` | string | Unset for slug, `id` for numeric ID |

**Returns:** NewsPost with `content` (rendered HTML) and `navigation` (newer/older posts).

---

## 13. Search

### `GET /search`
Search across users and wiki pages.

| Param | Type | Description |
|-------|------|-------------|
| `query` | string | Search query |
| `mode` | string | `all`, `user`, `wiki_page` |
| `page` | int | Page number |

**Returns:** Combined search results.

---

## 14. Events

### `GET /events`
Get global site events.

| Param | Type | Description |
|-------|------|-------------|
| `sort` | string | `id_desc` or `id_asc` |

**Returns:** `{ events: Event[], cursor_string }`

**Event types:** `achievement`, `beatmapPlaycount`, `beatmapsetApprove`, `beatmapsetDelete`, `beatmapsetRevive`, `beatmapsetUpdate`, `beatmapsetUpload`, `rank`, `rankLost`, `userSupportFirst`, `userSupportAgain`, `userSupportGift`, `usernameChange`

---

## 15. Forum

### `GET /forums`
List all top-level forums with subforums (2 levels).

**Returns:** `{ forums: Forum[] }`

**Forum fields:** `forum_id`, `name`, `description`, `parent_id`, `topic_count`, `post_count`

---

### `GET /forums/{forum}`
Get a specific forum with its topics.

| Param | Type | Description |
|-------|------|-------------|
| `sort` | string | Sort order |
| `with_replies` | bool | Include reply info |

**Returns:** `{ forum, topics: ForumTopic[], pinned_topics: ForumTopic[] }`

---

### `GET /forums/topics`
List forum topics.

| Param | Type | Description |
|-------|------|-------------|
| `forum_id` | int | Filter by forum |
| `sort` | string | `new` or `old` |
| `limit` | int | Max 50 |
| `cursor_string` | string | Pagination cursor |

**Returns:** `{ topics: ForumTopic[], cursor_string }`

---

### `GET /forums/topics/{topic}`
Get a forum topic with its posts.

| Param | Type | Description |
|-------|------|-------------|
| `sort` | string | `id_asc` or `id_desc` |
| `limit` | int | Max 50 |
| `start` | int | Start post ID |
| `end` | int | End post ID |
| `cursor_string` | string | Pagination cursor |

**Returns:** `{ topic: ForumTopic, posts: ForumPost[] (with body), cursor_string, search }`

---

## 16. Chat

> **Scope:** `chat.read` required for all chat endpoints.

### `GET /chat/channels`
List all joinable public channels.

**Returns:** Array of `ChatChannel` objects.

**Fields:** `channel_id`, `description`, `icon`, `moderated`, `name`, `type`

---

### `GET /chat/channels/{channel}`
Get channel details.

**Returns:** `{ channel: ChatChannel, users: User[] }` (users visible for PM channels)

---

### `GET /chat/channels/{channel}/messages`
Get messages in a channel.

| Param | Type | Description |
|-------|------|-------------|
| `limit` | int | Max 50 |
| `since` | int | Messages after this ID |
| `until` | int | Messages before this ID |

**Returns:** Array of `ChatMessage` objects with sender info.

---

### `GET /chat/updates`
Get chat updates (new messages, silences, presence changes).

| Param | Type | Description |
|-------|------|-------------|
| `history_since` | int | Message history since this ID |
| `includes[]` | string[] | `presence`, `silences` |
| `since` | int | Required -- updates since this event ID |

**Returns:** `{ presence: ChatChannel[]?, silences: UserSilence[]? }`

---

### `GET /chat/presence`
Get channels the current user is in.

**Returns:** List of channels. *(Deprecated -- use `/chat/updates`)*

---

## 17. Friends & Blocks

### `GET /friends`
Get the authenticated user's friends list.

**Scope:** `friends.read`

**Returns:** Array of `UserRelation` objects with target user details.

---

### `GET /blocks`
Get the authenticated user's block list.

**Returns:** Array of `UserRelation` objects.

---

## 18. Notifications

### `GET /notifications`
Get the authenticated user's notifications.

| Param | Type | Description |
|-------|------|-------------|
| `max_id` | int | Notifications before this ID |

**Returns:** `{ notifications: Notification[], has_more, unread_count, notification_endpoint }`

---

## 19. Wiki

### `GET /wiki/{locale}/{path}`
Get a wiki page.

**Returns:** `WikiPage` object.

**Key fields:** `title`, `markdown`, `available_locales`, `layout`, `locale`, `path`, `subtitle`, `tags`

---

## 20. Spotlights

### `GET /spotlights`
List all spotlights (formerly "charts").

**Returns:** `{ spotlights: Spotlight[] }`

**Key fields:** `id`, `name`, `type`, `mode_specific`, `start_date`, `end_date`, `participant_count`

---

## 21. Seasonal Backgrounds

### `GET /seasonal-backgrounds`
Get current seasonal backgrounds.

**Returns:** `{ ends_at, backgrounds: SeasonalBackground[] }`

---

## 22. Tags

### `GET /tags`
Get all beatmap tags (used for advanced search/tagging).

**Returns:** `{ tags: Tag[] }`

---

## 23. Teams

### `GET /teams/{team}/{ruleset?}`
Get team details.

**Returns:** Team extended info.

---

## 24. Account / Me

### `GET /me/download-quota-check`
Check the authenticated user's download quota.

**Returns:** `{ quota_used: int }`

---

### `GET /me/beatmapset-favourites`
Get all beatmapset IDs the authenticated user has favourited.

**Scope:** `identify`

**Returns:** `{ beatmapset_ids: int[] }`

---

## 25. Key Data Models

### Score Object
| Field | Description |
|-------|-------------|
| `id` | Score ID |
| `user_id` | Player ID |
| `beatmap_id` | Beatmap ID |
| `ruleset_id` | 0=osu, 1=taiko, 2=catch, 3=mania |
| `total_score` | Total score |
| `accuracy` | 0.0 - 1.0 |
| `max_combo` | Max combo achieved |
| `passed` | Whether the score was a pass |
| `rank` | SS, S, A, B, C, D, F |
| `mods` | Array of mod objects (`{ acronym, settings }`) |
| `statistics` | Hit counts: `great`, `ok`, `meh`, `miss`, etc. |
| `pp` | Performance points (when available) |
| `ended_at` | Timestamp |
| `started_at` | Timestamp |
| `has_replay` | Whether replay is available |
| `best_id` | Best score ID |
| `legacy_score_id` | Legacy score ID |
| `legacy_total_score` | Legacy scoring total |
| `classic_total_score` | Classic scoring total |
| **Optional includes** | `beatmap`, `beatmapset`, `user`, `weight`, `rank_global`, `rank_country`, `position`, `scores_around` |

### User Object (Compact)
| Field | Description |
|-------|-------------|
| `id` | User ID |
| `username` | Display name |
| `avatar_url` | Avatar image URL |
| `country_code` | 2-letter country code |
| `default_group` | Primary group |
| `is_active` | Account active |
| `is_bot` | Bot account |
| `is_deleted` | Deleted account |
| `is_online` | Currently online |
| `is_supporter` | Has active supporter tag |
| `last_visit` | Last visit timestamp |
| `pm_friends_only` | PM restriction |
| `profile_colour` | Group colour |

### User Object (Extended -- adds to Compact)
| Field | Description |
|-------|-------------|
| `cover_url` | Profile cover image |
| `discord` | Discord username |
| `has_supported` | Has ever been supporter |
| `interests` | Profile interests |
| `join_date` | Registration date |
| `location` | Profile location |
| `occupation` | Profile occupation |
| `playmode` | Default game mode |
| `playstyle` | mouse, keyboard, tablet, touch |
| `post_count` | Forum posts |
| `profile_hue` | Custom profile colour hue |
| `profile_order` | Section order on profile |
| `title` | Special title |
| `title_url` | Title link |
| `twitter` | Twitter handle |
| `website` | Website URL |

### User Statistics Object
| Field | Description |
|-------|-------------|
| `global_rank` | Global rank |
| `country_rank` | Country rank |
| `pp` | Performance points |
| `ranked_score` | Total ranked score |
| `hit_accuracy` | Overall accuracy |
| `play_count` | Total plays |
| `play_time` | Total play time (seconds) |
| `total_score` | Total score across all plays |
| `total_hits` | Total hits |
| `maximum_combo` | All-time max combo |
| `replays_watched_by_others` | Replays watched count |
| `is_ranked` | Has enough plays to be ranked |
| `grade_counts` | `{ ss, ssh, s, sh, a }` |
| `level` | `{ current, progress }` |
| `variants` | Mania key variants (4k, 7k) |

---

## 26. Legacy API v1

> Base URL: `https://osu.ppy.sh/api/`
>
> Authentication: API key via `k` parameter (obtain from https://osu.ppy.sh/p/api/)
>
> Largely superseded by API v2 but still functional.

| Endpoint | Description | Key Params |
|----------|-------------|------------|
| `GET /get_beatmaps` | Get beatmaps | `k`, `since`, `s` (set ID), `b` (beatmap ID), `u` (user), `m` (mode), `a` (converts), `h` (hash), `limit` |
| `GET /get_user` | Get user data | `k`, `u`, `m`, `type` (id/string), `event_days` |
| `GET /get_scores` | Get scores on a beatmap | `k`, `b`, `u`, `m`, `mods`, `type`, `limit` |
| `GET /get_user_best` | Get user's top scores | `k`, `u`, `m`, `limit`, `type` |
| `GET /get_user_recent` | Get user's recent scores | `k`, `u`, `m`, `limit`, `type` |
| `GET /get_match` | Get multiplayer match | `k`, `mp` (match ID) |
| `GET /get_replay` | Get replay data | `k`, `b`, `u`, `m`, `s` (score ID), `mods` |

---

## Authentication Overview

### OAuth2 Scopes

| Scope | Description |
|-------|-------------|
| `identify` | Access own user profile |
| `friends.read` | Read friends list |
| `chat.read` | Read chat messages |
| `public` | Access public data (default for Client Credentials) |

### Grant Types

| Type | Use Case |
|------|----------|
| **Client Credentials** | Server-to-server, public data only. No user context. |
| **Authorization Code** | User-authenticated requests. Access user-specific data (friends, chat, own profile, played/unplayed filters). |

### Rate Limits
- **1200 requests per minute** per OAuth client
- Responses include `X-RateLimit-Limit` and `X-RateLimit-Remaining` headers
- Exceeding the limit returns `429 Too Many Requests`

### API Versioning
- Set via `x-api-version` header (e.g., `20220705`)
- Different versions may change response formats (e.g., legacy vs new score format)
