// Placeholder for src/lib/math/valuation.js
// Contains deterministic financial calculation functions (DCF, NPV, Sensitivity)

// Helper for rounding
function round(value, decimals) {
  return Number(Math.round(value + 'e' + decimals) + 'e-' + decimals);
}

/**
 * Calculates Discounted Cash Flow (DCF).
 * @param {number[]} cashFlows - Array of future cash flows.
 * @param {number} discountRate - The discount rate (e.g., 0.1 for 10%).
 * @param {number} terminalGrowth - The perpetual growth rate for terminal value (e.g., 0.02 for 2%).
 * @returns {number} The calculated DCF value.
 */
export function calcDcf(cashFlows, discountRate = 0.1, terminalGrowth = 0.02) {
  if (!Array.isArray(cashFlows) || cashFlows.some(v => typeof v !== 'number' || isNaN(v)) || cashFlows.length === 0) {
      console.error("calcDcf received invalid cashFlows:", cashFlows);
      return null; 
  }
   if (discountRate <= terminalGrowth) {
       console.error("Discount rate must be greater than terminal growth rate.");
       return null;
   }

  const pv = cashFlows
    .map((cf, i) => cf / Math.pow(1 + discountRate, i + 1))
    .reduce((a, b) => a + b, 0);

  const lastCf = cashFlows[cashFlows.length - 1];
  // Ensure lastCf is positive for terminal value calculation
  if (lastCf <= 0) {
      console.warn("Last cash flow is non-positive, terminal value will be 0 or negative.");
  }
  
  const terminalVal =
    (lastCf * (1 + terminalGrowth)) / (discountRate - terminalGrowth);

  const terminalPV =
    terminalVal / Math.pow(1 + discountRate, cashFlows.length);

  // Handle cases where terminal value might be nonsensical (e.g., negative CF with growth > discount)
  if (isNaN(pv + terminalPV)) {
      console.error("DCF calculation resulted in NaN. Check inputs.");
      return null;
  }

  return round(pv + terminalPV, 2);
}

/**
 * Calculates Net Present Value (NPV).
 * Note: Assumes cashFlows[0] is the initial investment (usually negative).
 * If no initial investment, provide it as 0 or use a different structure.
 * @param {number[]} cashFlows - Array of cash flows (including initial investment at index 0).
 * @param {number} discountRate - The discount rate (e.g., 0.1 for 10%).
 * @returns {number} The calculated NPV.
 */
export function calc_npv({ cashFlows, discountRate }) {
  console.log('Calculating NPV with:', { cashFlows, discountRate });
   if (!cashFlows || cashFlows.length === 0 || discountRate <= -1) {
    console.error('Invalid input for NPV calculation.');
    return 0; // Or throw error
  }
  // TODO: Implement actual NPV logic using mathjs if needed
  
  // Placeholder implementation
  const initialInvestment = cashFlows[0] || 0;
  const futureCashFlows = cashFlows.slice(1);
  const pvFutureFlows = futureCashFlows.reduce((sum, cf, i) => sum + cf / Math.pow(1 + discountRate, i + 1), 0);
  const npv = initialInvestment + pvFutureFlows;
  
  console.log('Calculated NPV:', npv);
  return npv;
}

/**
 * Runs a sensitivity analysis, typically varying discount rate and growth rate for DCF.
 * @param {object} params - Parameters for sensitivity analysis.
 * @param {number[]} params.cashFlows - Base cash flows.
 * @param {number[]} params.rates - Array of discount rates to test.
 * @param {number[]} params.growths - Array of terminal growth rates to test.
 * @returns {object[][]} A 2D array (matrix) of results, rows=rates, cols=growths.
 */
export function run_sensitivity({ cashFlows, rates, growths }) {
  console.log('Running Sensitivity Analysis with:', { cashFlows, rates, growths });
  if (!cashFlows || !rates || !growths || rates.length === 0 || growths.length === 0) {
     console.error('Invalid input for Sensitivity Analysis.');
    return [];
  }

  // TODO: Implement actual sensitivity logic
  // Placeholder implementation
  const results = rates.map(rate => {
    return growths.map(growth => {
      if (rate <= growth) return null; // Invalid combination
      return calcDcf(cashFlows, rate, growth);
    });
  });

  console.log('Sensitivity Analysis Results:', results);
  return results;
}

/**
 * Executes a function by name with given arguments.
 * Used by the RAG chain to call the correct math function.
 * @param {object} toolCall - The tool call object from LangChain/OpenAI.
 * @param {string} toolCall.name - The name of the function to call.
 * @param {object} toolCall.arguments - The arguments for the function.
 * @returns {any} The result of the function call.
 */
export function execFunction({ name, args }) {
  console.log(`Executing function: ${name} with args:`, args);
  let parsedArgs;
  try {
      parsedArgs = typeof args === 'string' ? JSON.parse(args) : args;
  } catch (e) {
      console.error("Failed to parse function arguments:", args);
      throw new Error(`Invalid arguments for function ${name}`);
  }

  switch (name) {
    case 'calc_dcf':
      // Ensure cashFlows is extracted correctly from args
      if (!parsedArgs || !Array.isArray(parsedArgs.cashFlows)) {
          throw new Error("Missing or invalid 'cashFlows' array for calc_dcf");
      }
      return calcDcf(parsedArgs.cashFlows, parsedArgs.discountRate, parsedArgs.terminalGrowth);
    case 'calc_npv':
      const npvArgs = typeof args === 'string' ? JSON.parse(args) : args;
      return calc_npv(npvArgs);
    case 'run_sensitivity':
       const sensitivityArgs = typeof args === 'string' ? JSON.parse(args) : args;
      return run_sensitivity(sensitivityArgs);
    case 'project_next_year': 
      if (!parsedArgs || !Array.isArray(parsedArgs.cashFlows)) {
          throw new Error("Missing or invalid 'cashFlows' array for project_next_year");
      }
      return projectNextYear(parsedArgs.cashFlows);
    case 'apply_multiple': 
      if (!parsedArgs || typeof parsedArgs.metricValue !== 'number' || typeof parsedArgs.multiple !== 'number') {
          throw new Error("Missing or invalid 'metricValue' or 'multiple' for apply_multiple");
      }
      return applyMultiple(parsedArgs.metricValue, parsedArgs.multiple);
    default:
      console.error(`Unknown function requested: ${name}`);
      throw new Error(`Function ${name} not found.`);
  }
}

/* Simple projection = last value × avg( YoY growth ) */
export function projectNextYear(cashFlows) {
  if (!Array.isArray(cashFlows) || cashFlows.some(v => typeof v !== 'number' || isNaN(v)) || cashFlows.length < 2) {
     console.error("projectNextYear received invalid cashFlows (needs at least 2 numeric values):". cashFlows);
     return null;
  }
  
  const growthRates = [];
  for (let i = 1; i < cashFlows.length; i++) {
      const prev = cashFlows[i-1];
      const current = cashFlows[i];
      // Avoid division by zero or negative denominator issues
      if (prev !== 0) { 
          growthRates.push((current - prev) / Math.abs(prev)); // Use Math.abs to handle negative bases if needed
      } else if (current !== 0) {
          growthRates.push(1.0); // Or handle as infinite growth / specific case
      } else {
          growthRates.push(0.0); // No growth if both are zero
      }
  }
    
  // Handle edge case where no valid growth rates could be calculated
  if (growthRates.length === 0) return cashFlows[cashFlows.length - 1]; // Return last value if no growth

  const avg = growthRates.reduce((a, b) => a + b, 0) / growthRates.length;
  // Ensure projection is based on a valid average growth rate
  if (isNaN(avg)) {
       console.error("Average growth rate calculation resulted in NaN.");
       return null;
  }
  return round(cashFlows[cashFlows.length - 1] * (1 + avg), 2);
}

/* Valuation via revenue multiple */
export function applyMultiple(metricValue, multiple) {
  if (typeof metricValue !== 'number' || isNaN(metricValue) || typeof multiple !== 'number' || isNaN(multiple)) {
      console.error("applyMultiple received invalid inputs:", { metricValue, multiple });
      return null;
  }
  return round(metricValue * multiple, 2);
} 