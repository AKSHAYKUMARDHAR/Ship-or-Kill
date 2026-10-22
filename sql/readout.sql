-- Readout counts for one A/B test, from a PostHog-style event table.
--
-- Input:  events(distinct_id, event, ts, variant, segment, partner_variant)
--         ts in seconds since the experiment started; variant and segment are on the exposure event
--         ($feature_flag_called), partner_variant on partner_joined.
-- Param:  $cutoff, the moment of the readout (seconds since start). Only events up to it are used.
--
-- Rules:
--   * A user's first exposure starts their clock (t0). Users exposed to both arms are left out of every
--     metric and counted in the both_arms audit, under the arm they saw first.
--   * Every metric counts a user only once their window has closed before the cutoff, so a user enrolled
--     an hour ago is never counted as "not retained on day 1".
--   * Windows: D0 activation [t0, t0 + 24 h); D1 retention [t0 + 24 h, t0 + 48 h);
--     D7 retention [t0 + 7 d, t0 + 8 d); uninstall, push disabled, crash [t0, t0 + 48 h).

WITH exposures AS (
    SELECT distinct_id,
           min(ts)                    AS t0,
           arg_min(variant, ts)       AS variant,
           arg_min(segment, ts)       AS segment,
           count(DISTINCT variant)    AS n_variants
    FROM events
    WHERE event = '$feature_flag_called' AND ts <= $cutoff
    GROUP BY distinct_id
),
units AS (
    SELECT * FROM exposures WHERE n_variants = 1
),
flags AS (
    SELECT u.distinct_id, u.variant, u.segment, u.t0,
           coalesce(bool_or(e.event = 'shared_game_completed' AND e.ts < u.t0 + 86400), false)  AS activated_d0,
           coalesce(bool_or(e.event = 'app_opened' AND e.ts >= u.t0 + 86400
                                                  AND e.ts <  u.t0 + 172800), false)            AS retained_d1,
           coalesce(bool_or(e.event = 'app_opened' AND e.ts >= u.t0 + 7 * 86400
                                                  AND e.ts <  u.t0 + 8 * 86400), false)         AS retained_d7,
           coalesce(bool_or(e.event = 'app_uninstalled' AND e.ts < u.t0 + 172800), false)       AS uninstalled_48h,
           coalesce(bool_or(e.event = 'push_disabled'   AND e.ts < u.t0 + 172800), false)       AS push_disabled_48h,
           coalesce(bool_or(e.event = 'app_crashed'     AND e.ts < u.t0 + 172800), false)       AS crashed_48h,
           -- tracking audits
           coalesce(bool_or(e.event = 'partner_joined'), false)                                 AS joined_any,
           coalesce(bool_or(e.event = 'shared_game_completed'), false)                          AS shared_any,
           coalesce(bool_or(e.event = 'partner_joined' AND e.partner_variant <> u.variant), false) AS partner_other_arm
    FROM units u
    LEFT JOIN events e ON e.distinct_id = u.distinct_id AND e.ts <= $cutoff AND e.ts >= u.t0
    GROUP BY ALL
),
arm_counts AS (
    SELECT variant,
           count(*)                                                              AS assigned,
           count(*) FILTER (WHERE t0 <= $cutoff - 86400)                         AS d0_eligible,
           count(*) FILTER (WHERE t0 <= $cutoff - 86400 AND activated_d0)        AS activated_d0,
           count(*) FILTER (WHERE t0 <= $cutoff - 172800)                        AS d1_eligible,
           count(*) FILTER (WHERE t0 <= $cutoff - 172800 AND retained_d1)        AS retained_d1,
           count(*) FILTER (WHERE t0 <= $cutoff - 172800 AND activated_d0)       AS d1_activated,
           count(*) FILTER (WHERE t0 <= $cutoff - 172800 AND activated_d0 AND retained_d1) AS d1_activated_retained,
           count(*) FILTER (WHERE t0 <= $cutoff - 8 * 86400)                     AS d7_eligible,
           count(*) FILTER (WHERE t0 <= $cutoff - 8 * 86400 AND retained_d7)     AS retained_d7,
           count(*) FILTER (WHERE t0 <= $cutoff - 172800 AND uninstalled_48h)    AS uninstalled_48h,
           count(*) FILTER (WHERE t0 <= $cutoff - 172800 AND push_disabled_48h)  AS push_disabled_48h,
           count(*) FILTER (WHERE t0 <= $cutoff - 172800 AND crashed_48h)        AS crashed_48h,
           count(*) FILTER (WHERE shared_any AND NOT joined_any)                 AS shared_without_partner,
           count(*) FILTER (WHERE joined_any)                                    AS joined_any,
           count(*) FILTER (WHERE partner_other_arm)                             AS partner_other_arm
    FROM flags
    GROUP BY variant
),
both_arms AS (
    SELECT variant, count(*) FILTER (WHERE n_variants > 1) AS both_arms, count(*) AS exposed
    FROM exposures
    GROUP BY variant
)
SELECT a.*, b.both_arms, b.exposed
FROM arm_counts a JOIN both_arms b USING (variant)
ORDER BY variant;
