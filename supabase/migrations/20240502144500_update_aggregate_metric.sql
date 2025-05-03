-- Drop the old function if it exists
DROP FUNCTION IF EXISTS public.aggregate_metric(TEXT, TEXT, TEXT, TEXT);

-- Recreate the function to return JSONB with sum and avg
CREATE OR REPLACE FUNCTION public.aggregate_metric(
  _catalog_filter TEXT,
  _metric_filter TEXT DEFAULT 'royalty_line',
  _period_pattern TEXT DEFAULT '%'
) 
RETURNS JSONB -- Return JSONB containing both sum and avg
AS $$
DECLARE
  result JSONB;
BEGIN
  -- Validate inputs
  IF _catalog_filter IS NULL THEN
    RAISE EXCEPTION 'catalog_filter cannot be null';
  END IF;
  
  SELECT jsonb_build_object(
    'sum',  COALESCE(SUM(value), 0),
    'avg',  COALESCE(AVG(value), 0),
    'count', COUNT(value) -- Also return count for context
  )
  INTO result
  FROM public.rows -- Ensure schema is specified if needed
  WHERE 
    catalog = _catalog_filter
    AND metric = _metric_filter
    AND period LIKE _period_pattern; -- Keep using LIKE for now

  -- Return the JSONB object
  RETURN COALESCE(result, '{"sum": 0, "avg": 0, "count": 0}'::jsonb); -- Return default if no rows match
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE; -- Mark as STABLE as it only reads data

-- Grant execute permission
GRANT EXECUTE ON FUNCTION public.aggregate_metric(TEXT, TEXT, TEXT) TO authenticated, anon, service_role;

-- Add comment for documentation
COMMENT ON FUNCTION public.aggregate_metric(TEXT, TEXT, TEXT) IS 'Aggregates (SUM, AVG, COUNT) values from the rows table for a specific catalog, metric, and period pattern, returning a JSONB object.'; 