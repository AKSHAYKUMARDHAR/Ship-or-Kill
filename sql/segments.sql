-- Assigned users per arm, by segment and by enrolment day (for the sample ratio checks).
-- Same input and $cutoff as readout.sql; users exposed to both arms are left out, as there.

WITH exposures AS (
    SELECT distinct_id,
           min(ts)                 AS t0,
           arg_min(variant, ts)    AS variant,
           arg_min(segment, ts)    AS segment,
           count(DISTINCT variant) AS n_variants
    FROM events
    WHERE event = '$feature_flag_called' AND ts <= $cutoff
    GROUP BY distinct_id
)
SELECT 'segment' AS cut, segment AS level, variant, count(*) AS assigned
FROM exposures WHERE n_variants = 1 GROUP BY ALL
UNION ALL
SELECT 'day' AS cut, CAST(floor(t0 / 86400) + 1 AS INTEGER)::VARCHAR AS level, variant, count(*) AS assigned
FROM exposures WHERE n_variants = 1 GROUP BY ALL
ORDER BY cut, level, variant;
