-- Create a database function that can aggregate metrics for a catalog
-- This will be called by the calculateMetricSummary tool

CREATE OR REPLACE FUNCTION public.aggregate_metric(
  catalog_filter TEXT,
  metric_filter TEXT DEFAULT 'royalty_line',
  period_pattern TEXT DEFAULT '%',
  aggregation_type TEXT DEFAULT 'SUM'
) RETURNS NUMERIC AS $$
DECLARE
  result NUMERIC;
BEGIN
  -- Validate inputs
  IF catalog_filter IS NULL THEN
    RAISE EXCEPTION 'catalog_filter cannot be null';
  END IF;
  
  -- Choose aggregation type based on parameter
  IF aggregation_type = 'SUM' THEN
    SELECT COALESCE(SUM(value), 0)
    INTO result
    FROM rows
    WHERE 
      catalog = catalog_filter
      AND metric = metric_filter
      AND period LIKE period_pattern;
  ELSIF aggregation_type = 'AVG' THEN
    SELECT COALESCE(AVG(value), 0)
    INTO result
    FROM rows
    WHERE 
      catalog = catalog_filter
      AND metric = metric_filter
      AND period LIKE period_pattern;
  ELSE
    RAISE EXCEPTION 'Invalid aggregation_type: %. Must be SUM or AVG', aggregation_type;
  END IF;

  RETURN result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Grant execute permission to authenticated and anon roles
GRANT EXECUTE ON FUNCTION public.aggregate_metric TO authenticated, anon, service_role;

-- Add comment for documentation
COMMENT ON FUNCTION public.aggregate_metric IS 'Aggregates (SUM or AVG) values from the rows table for a specific catalog, metric, and period pattern.'; 