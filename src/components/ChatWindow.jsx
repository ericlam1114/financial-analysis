'use client';

import { useState, useEffect, forwardRef, useImperativeHandle, useRef } from 'react';
import { useChat, Message } from '@ai-sdk/react'; // Import useChat and Message (remove 'type')
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { TracePanel } from '@/components/TracePanel';
import ReactMarkdown from 'react-markdown'; // Import ReactMarkdown
import remarkMath from 'remark-math'; // Import remark-math
import rehypeKatex from 'rehype-katex'; // Import rehype-katex
import 'katex/dist/katex.min.css'; // Import KaTeX CSS
import { Paperclip, User, Bot, FileUp, BarChart2, FileText, Database } from 'lucide-react'; // Import icons
// Import the Supabase client
import { supabase } from '@/lib/supabaseClient';

export const ChatWindow = forwardRef((props, ref) => {
    const { initialMessages = [], catalog = 'default', clientName = 'Selected Catalog', availableCatalogs = [], onFileUpload } = props;
    
    // --- State for Trace Panel Data ---
    const [retrievedContextRows, setRetrievedContextRows] = useState([]);
    const [lastFunctionCall, setLastFunctionCall] = useState(null);
    const [lastFunctionResult, setLastFunctionResult] = useState(null);
    const [activePanelTab, setActivePanelTab] = useState('analysis');
    
    // --- State for File Upload Tracking ---
    const fileInputRef = useRef(null);
    const chatContainerRef = useRef(null); // Add ref for chat container
    const [uploadedFiles, setUploadedFiles] = useState([]);
    const [isUploading, setIsUploading] = useState(false);
    const [currentFileName, setCurrentFileName] = useState('');
    const [jobStatus, setJobStatus] = useState('');
    const [lastUploadError, setLastUploadError] = useState('');
    const [lastUploadSuccess, setLastUploadSuccess] = useState('');
    const [activeJobId, setActiveJobId] = useState(null);
    const [processedCount, setProcessedCount] = useState(0);
    const [totalCount, setTotalCount] = useState(0);
    const [jobErrorMessage, setJobErrorMessage] = useState(null);
    const [docType, setDocType] = useState('evaluation');

    const { messages, input, handleInputChange, handleSubmit, isLoading, error, data, setMessages }
        = useChat({
            // Point to the API route we created
            api: '/api/chat',
            // Pass initial messages if provided
            initialMessages: initialMessages,
            // Send the catalog field in the body
            body: {
                catalog: catalog,
            },
             // Clear trace panel on new submission
            onNewMessageSend: () => {
                // We clear these here AND in onFinish for robustness
                setLastFunctionCall(null);
                setLastFunctionResult(null);
            },
            // Update Analysis Panel state when the stream finishes
            onFinish: (message) => {
              console.log("useChat onFinish - final message:", message);
              
              // Extract tool calls from the final assistant message
              if (message.role === 'assistant' && message.toolInvocations && message.toolInvocations.length > 0) {
                 const calls = message.toolInvocations.map(inv => 
                    `${inv.toolName}(${JSON.stringify(inv.args, null, 2)})`
                 ).join('\n');
                 console.log("Setting lastFunctionCall from onFinish:", calls);
                 setLastFunctionCall(calls);
              } else {
                  // If the last message wasn't an assistant message with tool calls,
                  // check previous messages (less ideal, but a fallback)
                  const lastAssistantMsgWithTools = [...messages, message].reverse().find(m => m.role === 'assistant' && m.toolInvocations?.length > 0);
                  if (lastAssistantMsgWithTools?.toolInvocations) {
                     const calls = lastAssistantMsgWithTools.toolInvocations.map(inv => 
                        `${inv.toolName}(${JSON.stringify(inv.args, null, 2)})`
                     ).join('\n');
                     console.log("Setting lastFunctionCall from onFinish (fallback search):", calls);
                     setLastFunctionCall(calls);
                  } else {
                      console.log("No tool calls found in onFinish message or history.");
                      setLastFunctionCall(null); // Explicitly clear if no tool used
                  }
              }
              
              // Extract tool results (look for message with role: 'tool')
              // The result might be in a separate message before the final assistant message
              const toolResultMessage = [...messages, message].reverse().find(m => m.role === 'tool');
              if (toolResultMessage?.result) {
                  const resultString = JSON.stringify(toolResultMessage.result, null, 2);
                  console.log("Setting lastFunctionResult from onFinish:", resultString);
                  setLastFunctionResult(resultString);
              } else {
                  console.log("No tool result message found in onFinish history.");
                  setLastFunctionResult(null); // Explicitly clear
              }
            }
        });

    // Handle file upload from chat input
    const handleFileUploadClick = () => {
        // Switch to data tab
        setActivePanelTab('data');
        setTimeout(() => {
            fileInputRef.current?.click();
        }, 100);
    };

    // Handle file changes from the input element
    const handleFileChange = (e) => {
        const files = Array.from(e.target.files || []);
        if (files.length > 0) {
             // For now, handle only the first file
             handleFileUpload(files[0]); 
             // If handling multiple, you'd loop here and manage state differently
        }
         // Clear the file input value so the same file can be selected again
         if (fileInputRef.current) {
            fileInputRef.current.value = "";
         }
    };

    // Renamed from handleFileUpload in previous steps, now the main upload handler
    const handleFileUpload = async (file) => {
        if (!supabase) {
            setLastUploadError('Error: Supabase client not available.');
            return; // Exit early
        }
        if (!file) {
            setLastUploadError('Error: No file provided to upload function.');
            return; // Exit early
        }
        
        // Reset state at the START of a new upload attempt
        setIsUploading(true);
        setLastUploadError(null);
        setLastUploadSuccess(null);
        setActiveJobId(null); 
        setJobStatus('initiating'); // New initial status
        setProcessedCount(0);
        setTotalCount(0);
        setJobErrorMessage(null);
        setCurrentFileName(file.name); // Set current file name
    
        let insertedFileId = null; 
    
        try {
          setJobStatus('pending_db');
          
          // Derive catalog name (ensure this logic is robust)
          const baseFileName = file.name.split('.').slice(0, -1).join('.') || `file_${Date.now()}`;
          const catalogName = `${baseFileName}`; // Use base name as catalog, adjust if needed
          
          const fileInsertData = {
              name: file.name, // Store original filename in 'files' table
              mime_type: file.type || 'application/octet-stream', 
              catalog: catalogName,  
              doc_type: docType, // docType state from component     
          };
    
          console.log("Inserting file record:", fileInsertData);
          // ... (rest of the try block: insert into files, get signed URL, upload to storage) ...
          // MAKE SURE this logic matches the original handleFileUpload 
          // (I'm assuming it was correct based on terminal logs showing signed URL call)
           const { data: fileRecord, error: insertError } = await supabase
               .from('files')
               .insert(fileInsertData)
               .select('id')
               .single();

          if (insertError) throw new Error(`Failed to create file record: ${insertError.message}`);
          if (!fileRecord || !fileRecord.id) throw new Error('Failed to get ID back from file record insertion.');

          insertedFileId = fileRecord.id;
          console.log(`File record created successfully with ID: ${insertedFileId}`);
          setJobStatus('requesting_url');

          const signedUrlResponse = await fetch('/api/storage/signed-url', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ filename: file.name, file_id: insertedFileId }), // Pass file_id
          });

          if (!signedUrlResponse.ok) {
              const errorData = await signedUrlResponse.json();
              throw new Error(`Failed to get signed URL: ${errorData.error || signedUrlResponse.statusText}`);
          }

          const { signedUrl, path } = await signedUrlResponse.json();
          console.log(`Received signed URL for path: ${path}`);
          setJobStatus('uploading');

          const uploadResponse = await fetch(signedUrl, {
              method: 'PUT',
              body: file,
              headers: { 'Content-Type': file.type || 'application/octet-stream' },
          });

          if (!uploadResponse.ok) {
              let errorDetail = uploadResponse.statusText;
              try {
                  const xmlError = await uploadResponse.text(); 
                  console.error('Direct upload failed response:', xmlError);
                  const messageMatch = xmlError.match(/<Message>(.*?)<\/Message>/);
                  if (messageMatch && messageMatch[1]) errorDetail = messageMatch[1];
              } catch (parseError) { /* Ignore */ }
              throw new Error(`Direct file upload failed: ${uploadResponse.status} ${errorDetail}`);
          }

          console.log('File upload complete via UI. Waiting for backend processing job queue...');
          setJobStatus('queued'); // Set status to queued, backend webhook handles the rest
          setLastUploadSuccess(`File "${file.name}" uploaded. Processing queued.`);
          // We don't poll here anymore, the webhook triggers the worker

        } catch (error) {
           // ... (existing error handling) ...
           console.error('handleFileUpload error:', error);
           setLastUploadError(error.message || 'An unexpected error occurred during upload.');
           setJobStatus('error');
           if (insertedFileId) {
              try {
                  console.log(`Updating file ${insertedFileId} status to error in DB...`);
                  await supabase.from('files').update({ status: 'error', error_message: String(error.message || 'Unknown error').substring(0, 250) }).eq('id', insertedFileId);
              } catch (dbError) {
                  console.error("Failed to update file status to error in DB:", dbError);
              }
           }
        } finally {
             // Only set uploading to false once the final state (queued, error, or completed via polling if added) is reached
             // For now, let's set it false once it's queued or errored.
             if (jobStatus === 'queued' || jobStatus === 'error') {
                setIsUploading(false);
             } 
             // A more robust solution would involve polling the job status via the activeJobId
             // and setting isUploading=false only on 'completed' or 'failed'.
        }
      };

    // Expose data for export using useChat state
    useImperativeHandle(ref, () => ({
        getExportData: () => ({
            messages,
            retrievedRows: retrievedContextRows, // Use the state populated from the data stream
            functionCall: lastFunctionCall,
            functionResult: lastFunctionResult,
        })
    }));

    // Effect to potentially clear trace panel if messages are manually reset (optional)
    useEffect(() => {
        if (messages.length === initialMessages.length) {
            // Clear here too if messages are externally reset
             setLastFunctionCall(null);
             setLastFunctionResult(null);
        }
    }, [messages, initialMessages]);

    // Effect to update analysis panel when messages change - KEEP COMMENTED OUT
    /* // Temporarily commented out to debug 'Maximum update depth exceeded' error
    useEffect(() => {
        // ... previous logic ...
    }, [data]); // Dependency changed to [data]
    */

    // Format file size
    const formatFileSize = (bytes) => {
        if (bytes < 1024) return bytes + ' B';
        else if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
        else return (bytes / 1048576).toFixed(1) + ' MB';
    };

    // Log the messages state whenever it changes
    useEffect(() => {
        console.log("ChatWindow messages state:", messages);
    }, [messages]);

    // Effect to scroll to bottom when messages change
    // Re-enabled after fixing the Analysis Panel update loop
    useEffect(() => {
        if (chatContainerRef.current) {
            // Use setTimeout to ensure scrolling happens after DOM update
            const timer = setTimeout(() => {
                if (chatContainerRef.current) { // Check again inside timeout
                   chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
                }
            }, 0); // Minimal delay
            return () => clearTimeout(timer); // Cleanup timeout on unmount/re-run
        }
    }, [messages]);

    return (
        <div className="flex h-[500px]">
            {/* Chat Area */}
            <div className="flex flex-col w-2/3 border rounded-lg mr-4 overflow-hidden bg-white">
                {/* Conditional Rendering: Show Chat or Upload Prompt */}
                {!catalog ? (
                    <div className="flex flex-col items-center justify-center h-full p-6 text-center">
                        <Database size={40} className="text-gray-400 mb-4" />
                        <h3 className="text-lg font-medium text-gray-700 mb-2">No Catalog Selected</h3>
                        <p className="text-sm text-gray-500 mb-4">Upload a data file to get started or select an existing catalog if available.</p>
                        <Button 
                            onClick={handleFileUploadClick} 
                            variant="default"
                            className="bg-blue-600 hover:bg-blue-700 text-white"
                        >
                            <FileUp size={16} className="mr-2" /> Upload Data File
                        </Button>
                        {/* Hidden file input remains */}
                        <input 
                           type="file" 
                           ref={fileInputRef} 
                           onChange={handleFileChange} 
                           style={{ display: 'none' }} 
                           multiple 
                        />
                        {/* Display upload status if uploading from here */}
                         {isUploading && (
                            <div className="mt-4 text-sm text-gray-600 flex items-center space-x-2">
                                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-500"></div>
                                <span>Uploading {currentFileName}... Status: {jobStatus}</span>
                            </div>
                        )}
                        {lastUploadError && <div className="mt-4 text-sm text-red-500">Error: {lastUploadError}</div>}
                        {lastUploadSuccess && <div className="mt-4 text-sm text-green-500">{lastUploadSuccess}</div>}
                    </div>
                ) : (
                    <> 
                        {/* Original Chat Content Area */}
                        <div ref={chatContainerRef} className="flex-grow overflow-y-auto p-6 space-y-6 h-[400px]">
                           {/* ... messages.map logic ... */} 
                    {messages.map((msg) => (
                                <div key={msg.id} className={`flex items-start gap-3 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                                    {/* Simple Avatar Placeholder */}
                                    {msg.role !== 'user' && (
                                        <div className="w-8 h-8 rounded-full bg-black flex items-center justify-center text-white shrink-0">
                                            <Bot size={18} />
                                        </div>
                                    )}
                                    {/* Message Bubble */}
                                    <div
                                        className={`rounded-md px-4 py-2.5 max-w-[80%] ${ 
                                            msg.role === 'user' 
                                                ? 'bg-gray-800 text-white'
                                                : 'bg-gray-100 text-black'
                                }`}
                                    >
                                        {msg.role === 'user' ? (
                                            <span className="whitespace-pre-wrap">{msg.content}</span>
                                        ) : (
                                            // Apply prose styling to a wrapper div
                                            <div className="prose prose-sm max-w-none">
                                                <ReactMarkdown 
                                                    remarkPlugins={[remarkMath]}
                                                    rehypePlugins={[rehypeKatex]}
                            >
                                {msg.content}
                                                </ReactMarkdown> 
                                            </div>
                                        )}
                                    </div>
                                    {/* Simple Avatar Placeholder */}
                                    {msg.role === 'user' && (
                                        <div className="w-8 h-8 rounded-full bg-blue-500 flex items-center justify-center text-white shrink-0">
                                            <User size={18} />
                            </div>
                                    )}
                        </div>
                    ))}
                            {/* ... isLoading and error display ... */} 
                    {isLoading && messages.length > 0 && messages[messages.length - 1].role === 'user' && (
                                <div className="flex justify-center text-gray-500">
                                    <div className="w-8 h-8 rounded-full bg-black flex items-center justify-center text-white shrink-0 mr-3">
                                        <Bot size={18} />
                                    </div>
                                    <span>Thinking...</span>
                                </div>
                    )}
                    {error && (
                         <div className="text-center text-red-500 p-2 rounded bg-red-100 border border-red-300">
                            Error: {error.message}
                        </div>
                    )}
                </div>
                        {/* Chat Input Form */}
                <form 
                    onSubmit={(e) => {
                                handleSubmit(e, { body: { catalog: catalog, client_name: clientName } });
                    }}
                            className="p-4 border-t bg-white flex items-center space-x-2 shrink-0"
                 >
                            {/* Button to trigger the SAME file input used by the empty state */}
                            <Button 
                                type="button" 
                                onClick={handleFileUploadClick} 
                                variant="outline" 
                                className="h-10 w-10 p-2"
                                title="Upload file"
                            >
                                <FileUp size={18} />
                            </Button>
                             {/* Hidden file input */}
                             <input 
                                type="file" 
                                ref={fileInputRef} 
                                onChange={handleFileChange} 
                                style={{ display: 'none' }} 
                                multiple 
                             />
                    <Input
                        value={input}
                                onChange={handleInputChange}
                        placeholder="Ask a valuation question..."
                        disabled={isLoading}
                                className="flex-grow bg-gray-50 border-gray-300 rounded-md focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
                    />
                            <Button type="submit" disabled={isLoading || !input.trim()} className="bg-gray-800 hover:bg-gray-700 text-white">Send</Button>
                </form>
                    </>
                )}
            </div>

            {/* Enhanced Analysis Panel Area */}
            <div className="w-1/3 h-full flex flex-col">
                {/* Tab navigation */}
                <div className="flex border-b">
                    <button
                        className={`px-4 py-2 text-sm font-medium ${activePanelTab === 'analysis' ? 'border-b-2 border-blue-500 text-blue-600' : 'text-gray-500 hover:text-gray-700'}`}
                        onClick={() => setActivePanelTab('analysis')}
                    >
                        <BarChart2 size={16} className="inline mr-1" /> Analysis
                    </button>
                    <button
                        className={`px-4 py-2 text-sm font-medium ${activePanelTab === 'context' ? 'border-b-2 border-blue-500 text-blue-600' : 'text-gray-500 hover:text-gray-700'}`}
                        onClick={() => setActivePanelTab('context')}
                    >
                        <FileText size={16} className="inline mr-1" /> Context
                    </button>
                    <button
                        className={`px-4 py-2 text-sm font-medium ${activePanelTab === 'data' ? 'border-b-2 border-blue-500 text-blue-600' : 'text-gray-500 hover:text-gray-700'}`}
                        onClick={() => setActivePanelTab('data')}
                    >
                        <Database size={16} className="inline mr-1" /> Data
                    </button>
                </div>

                {/* Panel content */}
                <div className="flex-grow overflow-y-auto p-4 bg-gray-50 rounded-b-lg">
                    {activePanelTab === 'analysis' && (
                        <div className="space-y-4">
                            <div className="bg-white border rounded-lg p-4">
                                <h3 className="text-sm font-medium mb-3">Query Analysis</h3>
                                <dl className="space-y-2 text-sm">
                                    <div className="flex justify-between">
                                        <dt className="text-gray-500">Tool Call:</dt>
                                        <dd className="font-medium text-right whitespace-pre-wrap">{lastFunctionCall || 'N/A'}</dd>
                                    </div>
                                    {lastFunctionResult && (
                                        <div className="flex flex-col pt-2">
                                            <dt className="text-gray-500 mb-1">Tool Result:</dt>
                                            <dd className="font-mono text-xs bg-gray-100 p-2 rounded overflow-x-auto">
                                                {lastFunctionResult} 
                                            </dd>
                                        </div>
                                    )}
                                </dl>
                            </div>
                        </div>
                    )}

                    {activePanelTab === 'context' && (
                        <div>
                            <h3 className="text-sm font-medium mb-2">Retrieved Context</h3>
                            {retrievedContextRows.length > 0 ? (
                                <div className="space-y-2">
                                    {retrievedContextRows.map((row, i) => (
                                        <div key={i} className="p-2 bg-white border rounded text-xs">
                                            <div className="font-medium">Row ID: {row.id || i+1}</div>
                                            <div className="mt-1 text-gray-700 line-clamp-3">
                                                {row.content || "Content not available"}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            ) : (
                                <div className="text-gray-500 text-sm">No context retrieved yet. Ask a question to see relevant data.</div>
                            )}
                        </div>
                    )}

                    {activePanelTab === 'data' && (
                        <div className="space-y-4">
                            {/* Current data source info */}
                            <div className="bg-white border rounded-lg p-4">
                                <h3 className="text-sm font-medium mb-3">Data Source</h3>
                                <div className="flex items-center justify-between mb-2">
                                    <span className="text-gray-500">Catalog:</span>
                                    <span className="font-medium text-blue-600">{clientName || catalog}</span>
                                </div>
                                <div className="text-xs text-gray-500">
                                    {lastFunctionCall ? (
                                        <div>
                                            <div className="mb-1">Function Called:</div>
                                            <pre className="bg-gray-100 p-2 rounded overflow-x-auto text-xs">
                                                {lastFunctionCall}
                                            </pre>
                                        </div>
                                    ) : (
                                        <div>Using general context retrieval</div>
                                    )}
                                </div>
                            </div>

                            {/* Upload interface */}
                            <div className="bg-white border rounded-lg p-4">
                                <h3 className="text-sm font-medium mb-3">Upload Files</h3>
                                <div className="space-y-4">
                                    {/* File type selector */}
                                    <div className="space-y-2">
                                        <span className="text-xs font-medium">File Type</span>
                                        <div className="flex flex-wrap gap-2">
                                            <span className="px-2 py-1 text-xs bg-blue-500 text-white rounded">
                                                Financial Statements
                                            </span>
                                            <span className="px-2 py-1 text-xs border border-gray-300 rounded">
                                                Royalty Reports
                                            </span>
                                            <span className="px-2 py-1 text-xs border border-gray-300 rounded">
                                                Custom Data
                                            </span>
                                        </div>
                                    </div>

                                    {/* Dropzone */}
                                    <div
                                        className="border-2 border-dashed rounded-md p-6 text-center border-gray-300"
                                        onClick={() => fileInputRef.current?.click()}
                                    >
                                        <div className="flex flex-col items-center">
                                            <FileUp className="h-8 w-8 text-gray-400 mb-2" />
                                            <p className="text-sm font-medium">Drag & drop files here or click to browse</p>
                                            <p className="text-xs text-gray-500 mt-1">
                                                Supports Excel, CSV, PDF files up to 10MB
                                            </p>
                                        </div>
                                    </div>

                                    {/* Uploaded files list */}
                                    {uploadedFiles.length > 0 && (
                                        <div className="space-y-2">
                                            <span className="text-xs font-medium">Uploaded Files</span>
                                            <div className="space-y-2 max-h-[150px] overflow-y-auto">
                                                {uploadedFiles.map((file, index) => (
                                                    <div key={index} className="bg-white border rounded-md p-2 text-xs flex flex-col">
                                                        <div className="font-medium truncate">{file.name}</div>
                                                        <div className="text-gray-500 text-[10px]">
                                                            {formatFileSize(file.size)}
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                            <div className="text-xs text-green-500">{uploadedFiles.length} files uploaded</div>
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                    )}
                </div>
                
                {/* Original TracePanel - now hidden but kept in case we need to reference its implementation */}
                <div className="hidden">
                <TracePanel 
                        retrievedRows={retrievedContextRows}
                        functionCall={lastFunctionCall}
                        functionCallResult={lastFunctionResult}
                />
                </div>
            </div>
        </div>
    );
});

ChatWindow.displayName = 'ChatWindow'; 