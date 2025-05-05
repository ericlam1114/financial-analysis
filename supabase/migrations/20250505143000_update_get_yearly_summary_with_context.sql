-- supabase/migrations/YYYYMMDDHHMMSS_update_get_yearly_summary_with_context.sql

-- Drop the old function definition if it exists (optional, but safe)
DROP FUNCTION IF EXISTS public.get_yearly_summary(text, text);

-- Create or replace the function to return period context
CREATE OR REPLACE FUNCTION public.get_yearly_summary(
    catalog_filter_param text,
    metric_column_name text
)
RETURNS TABLE(year integer, total_sum numeric, period_type text, start_date date, end_date date)
LANGUAGE plpgsql
STABLE -- Function only reads data
AS $$
DECLARE
    v_current_year integer := EXTRACT(YEAR FROM CURRENT_DATE);
    v_current_date date := CURRENT_DATE;
BEGIN
    RETURN QUERY
    WITH YearlyData AS (
        SELECT
            -- Extract year from the period string (assuming YYYYMM or YYYYMMDD format)
            CAST(substring(period from 1 for 4) AS integer) AS extracted_year,
            -- Extract month to check for completeness
            CAST(substring(period from 5 for 2) AS integer) AS extracted_month,
            -- Use the dynamic metric column name
            CASE
                WHEN metric_column_name = 'amount_collected' THEN amount_collected
                WHEN metric_column_name = 'royalty_payable' THEN royalty_payable
                WHEN metric_column_name = 'units' THEN units
                WHEN metric_column_name = 'value' THEN value -- Assuming a generic 'value' column exists if passed
                ELSE 0 -- Default or handle error as appropriate
            END AS metric_value
        FROM public.rows
        WHERE catalog = catalog_filter_param
        AND period IS NOT NULL
        AND length(period) >= 6 -- Ensure period has at least YYYYMM
        AND period ~ '^[0-9]{6,8}$' -- Basic check for numeric period format
    ),
    AggregatedYears AS (
        SELECT
            extracted_year,
            SUM(COALESCE(metric_value, 0)) AS calculated_sum,
            -- Collect distinct months available for each year
            array_agg(DISTINCT extracted_month ORDER BY extracted_month) AS available_months
        FROM YearlyData
        GROUP BY extracted_year
    )
    SELECT
        ay.extracted_year AS year,
        ROUND(ay.calculated_sum, 2) AS total_sum,
        -- Determine period_type based on year and available months
        CASE
            -- If it's a past year, check if all 12 months are present
            WHEN ay.extracted_year < v_current_year THEN
                CASE
                    WHEN array_length(ay.available_months, 1) = 12 THEN 'FullYear'::text
                    ELSE 'PartialYear'::text -- Indicate past years with missing data
                END
            -- If it's the current year
            WHEN ay.extracted_year = v_current_year THEN 'YTD'::text
            -- Future years (should ideally not happen with real data)
            ELSE 'FutureYear'::text
        END AS period_type,
        -- Determine start_date
        (ay.extracted_year || '-01-01')::date AS start_date,
        -- Determine end_date
        CASE
            -- Past full years end on Dec 31st
            WHEN ay.extracted_year < v_current_year AND array_length(ay.available_months, 1) = 12 THEN (ay.extracted_year || '-12-31')::date
            -- Current year (YTD) or past partial years end on the date of the last data point for that year (approximated by current date for simplicity here)
            -- A more accurate end_date would require querying max(period) per year
            ELSE LEAST(v_current_date, (ay.extracted_year || '-12-31')::date)
        END AS end_date
    FROM AggregatedYears ay
    ORDER BY ay.extracted_year;
END;
$$;

-- Grant execute permission
GRANT EXECUTE ON FUNCTION public.get_yearly_summary(text, text) TO authenticated, anon, service_role;

-- Add comment for documentation
COMMENT ON FUNCTION public.get_yearly_summary(text, text) IS 'Retrieves yearly summary for a specific metric, including period context (type, start/end dates).';