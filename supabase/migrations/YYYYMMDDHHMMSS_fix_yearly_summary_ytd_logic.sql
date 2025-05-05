-- supabase/migrations/YYYYMMDDHHMMSS_fix_yearly_summary_ytd_logic.sql

-- Drop the previous function definition
DROP FUNCTION IF EXISTS public.get_yearly_summary(text, text);

-- Create or replace the function using MAX(period) instead of CURRENT_DATE
CREATE OR REPLACE FUNCTION public.get_yearly_summary(
    catalog_filter_param text,
    metric_column_name text
)
RETURNS TABLE(year integer, total_sum numeric, period_type text, start_date date, end_date date)
LANGUAGE plpgsql
STABLE -- Function only reads data
AS $$
DECLARE
    v_latest_period text;
    v_latest_year integer;
    v_latest_month integer;
    v_latest_day integer;
    v_latest_date date;
BEGIN
    -- Find the latest period string within this catalog
    SELECT MAX(period) INTO v_latest_period
    FROM public.rows
    WHERE catalog = catalog_filter_param
    AND period IS NOT NULL
    AND length(period) >= 6
    AND period ~ '^[0-9]{6,8}$';

    -- Determine the latest year and date from the data
    IF v_latest_period IS NULL THEN
        -- Handle case with no valid periods found for the catalog
        v_latest_year := 0;
        v_latest_date := '1900-01-01'::date; -- Set a default past date
    ELSE
        v_latest_year := CAST(substring(v_latest_period from 1 for 4) AS integer);
        v_latest_month := CAST(substring(v_latest_period from 5 for 2) AS integer);
        -- Attempt to get day if present (YYYYMMDD), default to end of month otherwise
        IF length(v_latest_period) = 8 THEN
            v_latest_day := CAST(substring(v_latest_period from 7 for 2) AS integer);
            v_latest_date := make_date(v_latest_year, v_latest_month, v_latest_day);
        ELSE
             -- End of month for YYYYMM format
             v_latest_date := (make_date(v_latest_year, v_latest_month, 1) + interval '1 month - 1 day')::date;
        END IF;
        -- Ensure generated date is valid
        BEGIN
           -- Try converting to validate date components
           v_latest_date := to_date(v_latest_period, CASE WHEN length(v_latest_period) = 8 THEN 'YYYYMMDD' ELSE 'YYYYMM' END);
           -- If YYYYMM, set to end of month
           IF length(v_latest_period) = 6 THEN
               v_latest_date := (v_latest_date + interval '1 month - 1 day')::date;
           END IF;
        EXCEPTION WHEN others THEN
            -- Fallback if date conversion fails (e.g. invalid day like 20240231)
            v_latest_date := (make_date(v_latest_year, v_latest_month, 1) + interval '1 month - 1 day')::date;
        END;

    END IF;

    RAISE NOTICE 'Latest Period: %, Latest Year: %, Latest Date: %', v_latest_period, v_latest_year, v_latest_date;

    RETURN QUERY
    WITH YearlyData AS (
        SELECT
            CAST(substring(period from 1 for 4) AS integer) AS extracted_year,
            CAST(substring(period from 5 for 2) AS integer) AS extracted_month,
            CASE
                WHEN metric_column_name = 'amount_collected' THEN amount_collected
                WHEN metric_column_name = 'royalty_payable' THEN royalty_payable
                WHEN metric_column_name = 'units' THEN units
                WHEN metric_column_name = 'value' THEN value
                ELSE 0
            END AS metric_value
        FROM public.rows
        WHERE catalog = catalog_filter_param
        AND period IS NOT NULL
        AND length(period) >= 6
        AND period ~ '^[0-9]{6,8}$'
    ),
    AggregatedYears AS (
        SELECT
            extracted_year,
            SUM(COALESCE(metric_value, 0)) AS calculated_sum,
            array_agg(DISTINCT extracted_month ORDER BY extracted_month) AS available_months
        FROM YearlyData
        GROUP BY extracted_year
    )
    SELECT
        ay.extracted_year AS year,
        ROUND(ay.calculated_sum, 2) AS total_sum,
        -- Determine period_type based on year relative to LATEST DATA YEAR
        CASE
            WHEN ay.extracted_year < v_latest_year THEN
                CASE
                    WHEN array_length(ay.available_months, 1) = 12 THEN 'FullYear'::text
                    ELSE 'PartialYear'::text -- Past year with missing months
                END
            WHEN ay.extracted_year = v_latest_year THEN
                 -- Use nested CASE instead of IF
                 CASE
                    WHEN v_latest_date = make_date(v_latest_year, 12, 31) THEN 'FullYear'::text
                    ELSE 'YTD'::text
                 END
            ELSE 'FutureYear'::text -- Should not happen if v_latest_year is correct
        END AS period_type,
        -- Determine start_date (always Jan 1st)
        make_date(ay.extracted_year, 1, 1) AS start_date,
        -- Determine end_date based on period_type determined above
        CASE
             WHEN ay.extracted_year < v_latest_year AND array_length(ay.available_months, 1) = 12 THEN make_date(ay.extracted_year, 12, 31)
             WHEN ay.extracted_year = v_latest_year THEN v_latest_date -- Use actual latest date from data
             ELSE make_date(ay.extracted_year, 12, 31) -- Default for PartialYear or FutureYear (less critical)
        END AS end_date
    FROM AggregatedYears ay
    ORDER BY ay.extracted_year;
END;
$$;

-- Grant execute permission
GRANT EXECUTE ON FUNCTION public.get_yearly_summary(text, text) TO authenticated, anon, service_role;

-- Add comment for documentation
COMMENT ON FUNCTION public.get_yearly_summary(text, text) IS 'Retrieves yearly summary for a specific metric, determining YTD/FullYear based on MAX(period) within the catalog.'; 