-- Function to get the top N rows based on value for a specific period

CREATE OR REPLACE FUNCTION public.get_top_n_rows(
  _catalog_filter TEXT,
  _metric_filter TEXT DEFAULT 'royalty_line',
  _period_pattern TEXT DEFAULT '%',
  _n INT DEFAULT 5 -- Default to top 5
) 
RETURNS JSONB -- Return a JSON array of rows
AS $$
DECLARE
  result JSONB;
BEGIN
  -- Validate inputs
  IF _catalog_filter IS NULL THEN
    RAISE EXCEPTION '_catalog_filter cannot be null';
  END IF;
  IF _n <= 0 THEN
     RAISE EXCEPTION '_n must be a positive integer';
  END IF;
  
  SELECT COALESCE(jsonb_agg(t), '[]'::jsonb)
  INTO result
  FROM (
    SELECT id, period, metric, value, content -- Select columns you want to return
    FROM public.rows
    WHERE 
      catalog = _catalog_filter
      AND metric = _metric_filter
      AND period LIKE _period_pattern
    ORDER BY value DESC -- Order by value to get top rows
    LIMIT _n -- Limit to the requested number
  ) t;

  RETURN result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- Grant execute permission
GRANT EXECUTE ON FUNCTION public.get_top_n_rows(TEXT, TEXT, TEXT, INT) TO authenticated, anon, service_role;

-- Add comment for documentation
COMMENT ON FUNCTION public.get_top_n_rows(TEXT, TEXT, TEXT, INT) IS 'Retrieves the top N rows (default 5) based on the value column for a specific catalog, metric, and period pattern, ordered by value descending.'; 