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
import { Paperclip, User, Upload, Bot, FileUp, BarChart2, FileText, Database } from 'lucide-react'; // Import icons
// Import the Supabase client
import { supabase } from '@/lib/supabaseClient';

// Helper function to generate catalog name (extracted for reuse)
const generateCatalogNameFromFile = (file) => {
    if (!file) return `catalog_${Date.now()}`;
    return file.name.split('.').slice(0, -1).join('.') || `file_${Date.now()}`;
};

export const ChatWindow = forwardRef((props, ref) => {
    const { initialMessages = [], catalog = 'default', clientName = 'Selected Catalog', availableCatalogs = [], onFileUpload } = props;

    // --- State for Trace Panel Data ---
    const [retrievedContextRows, setRetrievedContextRows] = useState([]);
    const [lastFunctionCall, setLastFunctionCall] = useState(null);
    const [lastFunctionResult, setLastFunctionResult] = useState(null);
    const [activePanelTab, setActivePanelTab] = useState('data');

    // --- State for File Upload Tracking ---
    const fileInputRef = useRef(null);
    const chatContainerRef = useRef(null); // Add ref for chat container
    const [isUploading, setIsUploading] = useState(false);
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

    // Handle file changes from the input element - NOW HANDLES BATCHES
    const handleFileChange = async (e) => {
        const files = Array.from(e.target.files || []);
        if (files.length === 0) {
            return; // No files selected
        }

        // Reset batch status & start loading indicator
        setIsUploading(true);
        setLastUploadError(null);
        setLastUploadSuccess(null);
        // Reset progress counters (optional, could show progress across files)
        setProcessedCount(0);
        setTotalCount(files.length);
        setJobStatus('initiating_batch'); // Indicate batch start

        let batchCatalog = '';
        let isNewCatalogUpload = false;

        // Determine target catalog ONCE for the batch
        if (activePanelTab === 'data' && catalog) {
            batchCatalog = catalog;
            console.log(`Upload batch initiated for 'data' tab. Adding ${files.length} files to existing catalog: ${batchCatalog}`);
        } else {
            // Default to 'upload' behavior: create new catalog based on first file
            batchCatalog = generateCatalogNameFromFile(files[0]);
            isNewCatalogUpload = true;
            console.log(`Upload batch initiated for 'upload' tab or no current catalog. Creating new catalog '${batchCatalog}' for ${files.length} files.`);
        }

        // Process files concurrently
        const uploadPromises = files.map(file => handleFileUpload(file, batchCatalog));
        const results = await Promise.allSettled(uploadPromises);

        // Consolidate results
        let successCount = 0;
        let errorCount = 0;
        const errors = [];

        results.forEach((result, index) => {
            if (result.status === 'fulfilled') {
                successCount++;
                console.log(`File ${index + 1} ('${files[index].name}') upload succeeded (queued).`);
            } else {
                errorCount++;
                errors.push(`File '${files[index].name}': ${result.reason?.message || 'Unknown error'}`);
                console.error(`File ${index + 1} ('${files[index].name}') upload failed:`, result.reason);
            }
        });

        // Update UI based on batch outcome
        if (errorCount > 0) {
            setLastUploadError(`${errorCount} of ${files.length} files failed to upload. Errors: ${errors.slice(0, 2).join(', ')}${errors.length > 2 ? '...' : ''}`);
        }
        if (successCount > 0) {
            setLastUploadSuccess(`${successCount} of ${files.length} files successfully uploaded to catalog \"${batchCatalog}\" and queued for processing.`);
            // Notify parent about the new catalog only if it was an 'upload' tab action and at least one file succeeded
            if (isNewCatalogUpload && onFileUpload) {
                onFileUpload(batchCatalog);
            }
        }

        setIsUploading(false);
        setJobStatus(errorCount > 0 ? 'batch_error' : 'batch_queued'); // Final batch status

        // Clear the file input value so the same files can be selected again if needed
        if (fileInputRef.current) {
            fileInputRef.current.value = "";
        }
    };

    // Main upload handler - NOW ACCEPTS targetCatalog and returns Promise
    const handleFileUpload = async (file, targetCatalog) => {
        // Removed internal state updates for isUploading, lastUploadSuccess, lastUploadError
        // Removed internal logic to determine catalog name

        return new Promise(async (resolve, reject) => {
            if (!supabase) {
                return reject(new Error('Supabase client not available.'));
            }
            if (!file) {
                return reject(new Error('No file provided to upload function.'));
            }
            if (!targetCatalog) {
                return reject(new Error('No target catalog determined for upload.'));
            }

            // Individual file state tracking (optional, for detailed progress)
            // We might need a different way to track this per-file if needed for UI
            // For now, focus on Promise resolve/reject for batch handling
            // setJobStatus('initiating_single'); // Example per-file status
            // setCurrentFileName(file.name);

            let insertedFileId = null;

            try {
                // setJobStatus('pending_db_single');
                const fileInsertData = {
                    name: file.name,
                    mime_type: file.type || 'application/octet-stream',
                    catalog: targetCatalog,
                    doc_type: docType,
                };

                console.log(`Inserting file record for ${file.name} into catalog ${targetCatalog}:`, fileInsertData);

                const { data: fileRecord, error: insertError } = await supabase
                    .from('files')
                    .insert(fileInsertData)
                    .select('id')
                    .single();

                if (insertError) throw new Error(`DB insert failed: ${insertError.message}`);
                if (!fileRecord || !fileRecord.id) throw new Error('DB insert failed to return ID.');

                insertedFileId = fileRecord.id;
                console.log(`File record created for ${file.name} with ID: ${insertedFileId}`);
                // setJobStatus('requesting_url_single');

                const signedUrlResponse = await fetch('/api/storage/signed-url', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ filename: file.name, file_id: insertedFileId }),
                });

                if (!signedUrlResponse.ok) {
                    const errorData = await signedUrlResponse.json();
                    throw new Error(`Signed URL fetch failed: ${errorData.error || signedUrlResponse.statusText}`);
                }

                const { signedUrl, path } = await signedUrlResponse.json();
                console.log(`Received signed URL for ${file.name}, path: ${path}`);
                // setJobStatus('uploading_single');

                const uploadResponse = await fetch(signedUrl, {
                    method: 'PUT',
                    body: file,
                    headers: { 'Content-Type': file.type || 'application/octet-stream' },
                });

                if (!uploadResponse.ok) {
                    let errorDetail = uploadResponse.statusText;
                    try {
                        const xmlError = await uploadResponse.text();
                        console.error(`Direct upload failed response for ${file.name}:`, xmlError);
                        const messageMatch = xmlError.match(/<Message>(.*?)<\/Message>/);
                        if (messageMatch && messageMatch[1]) errorDetail = messageMatch[1];
                    } catch (parseError) { /* Ignore */ }
                    throw new Error(`Storage upload failed: ${uploadResponse.status} ${errorDetail}`);
                }

                console.log(`File ${file.name} upload complete via UI. Queued for processing.`);
                // setJobStatus('queued_single');
                resolve({ fileId: insertedFileId, fileName: file.name }); // Resolve on success

            } catch (error) {
                console.error(`handleFileUpload error for ${file.name}:`, error);
                // Attempt to mark the file as error in DB even if part of the process failed
                if (insertedFileId) {
                    try {
                        console.warn(`Updating file ${insertedFileId} (${file.name}) status to error in DB due to upload failure...`);
                        await supabase.from('files').update({ status: 'error', error_message: String(error.message || 'Unknown upload error').substring(0, 250) }).eq('id', insertedFileId);
                    } catch (dbError) {
                        console.error(`Failed to update file status to error in DB for ${insertedFileId} (${file.name}):`, dbError);
                    }
                }
                reject(error); // Reject on error
            }
            // No 'finally' block needed here as Promise handles completion
        });
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
        <div className="flex h-[500px] ">
            {/* Chat Area */}
            <div className="flex shadow-sm flex-col w-2/3 border rounded-lg mr-4 overflow-hidden bg-white">
                {/* Conditional Rendering: Show Chat or Upload Prompt */}
                {!catalog ? (
                    <div className="flex flex-col items-center justify-center h-full p-6 text-center">
                        <Database size={40} className="text-gray-400 mb-4" />
                        <h3 className="text-lg font-medium text-gray-700 mb-2">No Catalog Selected</h3>
                        <p className="text-sm text-gray-500 mb-4">Upload a data file to create a new catalog or select an existing one.</p>
                        <Button
                            onClick={() => {
                                setActivePanelTab('upload'); // Switch to upload tab for initial upload
                                setTimeout(() => fileInputRef.current?.click(), 50); // Give state time to update before click
                            }}
                            variant="default"
                            className="bg-blue-600 hover:bg-blue-700 text-white"
                        >
                            <FileUp size={16} className="mr-2" /> Upload New Data File
                        </Button>
                        {/* Hidden file input remains */}
                        <input
                            type="file"
                            ref={fileInputRef}
                            onChange={handleFileChange}
                            style={{ display: 'none' }}
                            multiple
                        />
                        {/* Display BATCH upload status */}
                        {isUploading && (
                            <div className="mt-4 text-sm text-gray-600 flex items-center space-x-2">
                                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-500"></div>
                                <span>Uploading {totalCount} files...</span>
                                {/* Could add progress: <span>{processedCount}/{totalCount}</span> */}
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
                                    {/* {msg.role !== 'user' && (
                                        <div className="w-8 h-8 rounded-full bg-black flex items-center justify-center text-white shrink-0">
                                            <Bot size={18} />
                                        </div>
                                    )} */}
                                    {/* Message Bubble */}
                                    <div
                                        className={`rounded-2xl px-4 py-2.5 max-w-[80%] ${msg.role === 'user'
                                                ? 'bg-gray-100 text-black'
                                                : ' text-black'
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
                                    {/* {msg.role === 'user' && (
                                        <div className="w-8 h-8 rounded-full bg-blue-500 flex items-center justify-center text-white shrink-0">
                                            <User size={18} />
                                        </div>
                                    )} */}
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
                                onClick={() => {
                                    // Default attachment button should add to current catalog
                                    setActivePanelTab('data');
                                    setTimeout(() => fileInputRef.current?.click(), 50);
                                }}
                                variant="outline"
                                className="h-10 w-10 p-2 "
                                title="Add file to current catalog"
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
                                className=" shadow-sm flex-grow bg-gray-50 border-gray-300 rounded-md focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
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
                    {/* Removed Analysis/Context tabs for now */}
                    <button
                        className={`px-4 py-2 text-sm font-medium ${activePanelTab === 'data' ? 'border-b-2 border-blue-500 text-blue-600' : 'text-gray-500 hover:text-gray-700'}`}
                        onClick={() => setActivePanelTab('data')}
                    >
                        <Database size={16} className="inline mr-1" /> Catalog Info
                    </button>
                    <button
                        className={`px-4 py-2 text-sm font-medium ${activePanelTab === 'upload' ? 'border-b-2 border-blue-500 text-blue-600' : 'text-gray-500 hover:text-gray-700'}`}
                        onClick={() => setActivePanelTab('upload')}
                    >
                        <Upload size={16} className="inline mr-1" /> Upload New
                    </button>
                </div>

                {/* Panel content */}
                <div className="flex-grow overflow-y-auto p-4 bg-gray-50 rounded-b-lg">




                    {activePanelTab === 'data' && (
                        <div className="space-y-4">
                            {/* Current data source info */}
                            <div className="bg-white border rounded-lg p-4">
                                <h3 className="text-sm font-medium mb-2">Current Data Source</h3>
                                <div className="flex items-center justify-between">
                                    <span className="text-gray-500 text-xs">Catalog:</span>
                                    <span className="font-medium text-blue-600 text-sm truncate">{clientName || catalog || 'N/A'}</span>
                                </div>
                            </div>

                            {/* Upload interface for adding to current catalog */}
                            <div className="bg-white border rounded-lg p-4">
                                <h3 className="text-sm font-medium mb-3">Add Data to '{clientName || catalog || 'N/A'}'</h3>
                                {/* File type selector (kept static for now) */}
                                <div className="space-y-2 mb-4">
                                    <span className="text-xs font-medium">File Type</span>
                                    <div className="flex flex-wrap gap-2">
                                        {/* Add onClick handlers here later if needed */}
                                        <span className={`px-2 py-1 text-xs rounded cursor-pointer ${docType === 'evaluation' ? 'bg-blue-500 text-white' : 'border border-gray-300'}`} onClick={() => setDocType('evaluation')}>
                                            Financial Statements
                                        </span>
                                        <span className={`px-2 py-1 text-xs rounded cursor-pointer ${docType === 'royalty' ? 'bg-blue-500 text-white' : 'border border-gray-300'}`} onClick={() => setDocType('royalty')}>
                                            Royalty Reports
                                        </span>
                                        <span className={`px-2 py-1 text-xs rounded cursor-pointer ${docType === 'custom' ? 'bg-blue-500 text-white' : 'border border-gray-300'}`} onClick={() => setDocType('custom')}>
                                            Custom Data
                                        </span>
                                    </div>
                                </div>
                                {/* Dropzone for 'data' tab */}
                                <div
                                    className="border-2 border-dashed rounded-md p-6 text-center border-gray-300 cursor-pointer hover:border-blue-400"
                                    onClick={() => fileInputRef.current?.click()}
                                >
                                    <div className="flex flex-col items-center">
                                        <FileUp className="h-8 w-8 text-gray-400 mb-2" />
                                        <p className="text-sm font-medium">Click or drop files here to add</p>
                                        <p className="text-xs text-gray-500 mt-1">
                                            Supports Excel, CSV, PDF (max 10MB)
                                        </p>
                                    </div>
                                </div>
                                {/* Shared BATCH Upload Status Display */}
                                {isUploading && (
                                    <div className="mt-4 text-sm text-gray-600 flex items-center space-x-2">
                                        <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-500"></div>
                                        <span>Uploading {totalCount} files...</span>
                                    </div>
                                )}
                                {lastUploadError && <div className="mt-4 text-sm text-red-500">Error: {lastUploadError}</div>}
                                {lastUploadSuccess && <div className="mt-4 text-sm text-green-500">{lastUploadSuccess}</div>}
                            </div>
                        </div>
                    )}
                    {activePanelTab === 'upload' && (
                        <div className="space-y-4">
                            {/* No "Current Data Source" needed here */}
                            <div className="bg-white border rounded-lg p-4">
                                <h3 className="text-sm font-medium mb-3">Upload New Files as Catalog</h3>
                                <p className="text-xs text-gray-500 mb-3">
                                    Upload one or more files. The first file's name will determine the new catalog name.
                                </p>
                                {/* File type selector (kept static for now) */}
                                <div className="space-y-2 mb-4">
                                    <span className="text-xs font-medium">File Type</span>
                                    <div className="flex flex-wrap gap-2">
                                        {/* Add onClick handlers here later if needed */}
                                        <span className={`px-2 py-1 text-xs rounded cursor-pointer ${docType === 'evaluation' ? 'bg-blue-500 text-white' : 'border border-gray-300'}`} onClick={() => setDocType('evaluation')}>
                                            Financial Statements
                                        </span>
                                        <span className={`px-2 py-1 text-xs rounded cursor-pointer ${docType === 'royalty' ? 'bg-blue-500 text-white' : 'border border-gray-300'}`} onClick={() => setDocType('royalty')}>
                                            Royalty Reports
                                        </span>
                                        <span className={`px-2 py-1 text-xs rounded cursor-pointer ${docType === 'custom' ? 'bg-blue-500 text-white' : 'border border-gray-300'}`} onClick={() => setDocType('custom')}>
                                            Custom Data
                                        </span>
                                    </div>
                                </div>
                                {/* Dropzone for 'upload' tab */}
                                <div
                                    className="border-2 border-dashed rounded-md p-6 text-center border-gray-300 cursor-pointer hover:border-blue-400"
                                    onClick={() => fileInputRef.current?.click()}
                                >
                                    <div className="flex flex-col items-center">
                                        <FileUp className="h-8 w-8 text-gray-400 mb-2" />
                                        <p className="text-sm font-medium">Click or drop files here to upload</p>
                                        <p className="text-xs text-gray-500 mt-1">
                                            Supports Excel, CSV, PDF (max 10MB)
                                        </p>
                                    </div>
                                </div>
                                {/* Shared BATCH Upload Status Display */}
                                {isUploading && (
                                    <div className="mt-4 text-sm text-gray-600 flex items-center space-x-2">
                                        <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-500"></div>
                                        <span>Uploading {totalCount} files...</span>
                                    </div>
                                )}
                                {lastUploadError && <div className="mt-4 text-sm text-red-500">Error: {lastUploadError}</div>}
                                {lastUploadSuccess && <div className="mt-4 text-sm text-green-500">{lastUploadSuccess}</div>}
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
});

ChatWindow.displayName = 'ChatWindow'; 