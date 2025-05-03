'use client';

// Placeholder for TracePanel component
// This will display retrieved rows and function call results

export function TracePanel({ retrievedRows = [], functionCall = null, functionResult = null }) {
  return (
    <div className="border rounded-lg p-4 h-full overflow-y-auto bg-secondary/30">
      <h2 className="text-lg font-semibold mb-4">Analysis Breakdown</h2>
      
      <div className="mb-4">
        <h3 className="font-medium mb-2 text-sm uppercase text-muted-foreground">Context Used ({retrievedRows.length})</h3>
        {retrievedRows.length === 0 ? (
          <p className="text-sm text-gray-500">No context retrieved yet.</p>
        ) : (
          <ul className="space-y-2 text-xs">
            {retrievedRows.map((row, index) => (
              <li key={index} className="border-l-2 pl-2 border-muted-foreground/50">
                  <span className={`font-mono px-1 py-0.5 rounded text-xs ${row.metadata?.docType === 'evaluation' ? 'bg-blue-100 text-blue-800' : 'bg-gray-100 text-gray-800'}`}>
                      {row.metadata?.docType === 'evaluation' ? 'Evaluation' : 'Reference'}
                  </span>
                  <p className="mt-1 font-mono text-muted-foreground">{row.pageContent || JSON.stringify(row)}</p>
                  {row.metadata?.source && <p className="text-muted-foreground/70">Source: {row.metadata.source}</p>}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h3 className="font-medium mb-2 text-sm uppercase text-muted-foreground">Calculation Details</h3>
        {functionCall ? (
          <div className="text-xs space-y-1">
            <p><strong>Function Called:</strong> <code className="font-mono bg-muted px-1 py-0.5 rounded">{functionCall.name}</code></p>
            <p><strong>Arguments:</strong></p>
            <pre className="bg-muted p-2 rounded text-xs overflow-x-auto font-mono">
                {JSON.stringify(functionCall.arguments || {}, null, 2)}
            </pre>
          </div>
        ) : (
          <p className="text-sm text-gray-500">No calculation performed yet.</p>
        )}

        {functionResult !== null && functionResult !== undefined && (
           <div className="mt-2 text-xs space-y-1">
             <p><strong>Result:</strong></p>
             <pre className="bg-muted p-2 rounded text-xs overflow-x-auto font-mono">
                 {JSON.stringify(functionResult, null, 2)}
             </pre>
           </div>
        )}
      </div>
      {!functionCall && functionResult === null && (
           <p className="text-sm text-gray-500">No calculation performed for this query.</p>
      )}
    </div>
  );
} 