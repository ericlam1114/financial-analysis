'use client';

import { useState, useEffect, useCallback } from 'react';
import { FileDrop } from '@/components/FileDrop';
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { supabase } from '@/lib/supabaseClient';
import { Progress } from "@/components/ui/progress";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Terminal } from "lucide-react";

export default function UploadPage() {
  const [isUploading, setIsUploading] = useState(false);
  const [lastUploadError, setLastUploadError] = useState(null);
  const [lastUploadSuccess, setLastUploadSuccess] = useState(null);
  const [activeJobId, setActiveJobId] = useState(null);
  const [jobStatus, setJobStatus] = useState('idle');
  const [jobErrorMessage, setJobErrorMessage] = useState(null);
  const [processedCount, setProcessedCount] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [currentFileName, setCurrentFileName] = useState('');
  const [docType, setDocType] = useState('evaluation');

  useEffect(() => {
    if (!supabase || !activeJobId) return;

    console.log(`Setting up Realtime subscription for job ID: ${activeJobId}`);

    const channel = supabase.channel(`db-processing-queue-job-${activeJobId}`)
      .on(
        'postgres_changes',
        { 
          event: 'UPDATE',
          schema: 'public',
          table: 'processing_queue',
          filter: `id=eq.${activeJobId}`
        },
        (payload) => {
          console.log('Realtime UPDATE received:', payload);
          const updatedJob = payload.new;
          if (updatedJob) {
             setJobStatus(updatedJob.status);
             setProcessedCount(updatedJob.processed_row_count || 0);
             setTotalCount(updatedJob.total_row_count || 0);
             setJobErrorMessage(updatedJob.error_message || null);

             if (updatedJob.status === 'completed' || updatedJob.status === 'failed') {
                console.log(`Job ${activeJobId} finished with status: ${updatedJob.status}. Clearing activeJobId.`);
                 setActiveJobId(null); 
                 if (updatedJob.status === 'completed') {
                     setLastUploadSuccess(`Successfully processed ${currentFileName}.`);
                     setLastUploadError(null);
                 }
             }
          }
        }
      )
      .subscribe((status, err) => {
          if (status === 'SUBSCRIBED') {
              console.log(`Realtime subscribed successfully for job ${activeJobId}`);
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
              console.error('Realtime subscription error:', status, err);
              setLastUploadError('Realtime connection issue, progress updates might be unavailable.');
          }
      });

    return () => {
      if (channel) {
        console.log(`Cleaning up Realtime subscription for job ID: ${activeJobId}`);
        supabase.removeChannel(channel).catch(err => console.error('Error removing channel:', err));
      }
    };
  }, []);

  const handleFileUpload = async (file) => {
    if (!supabase) {
        setLastUploadError('Error: Supabase client not available.');
        setIsUploading(false);
        return;
    }
    
    setIsUploading(true);
    setLastUploadError(null);
    setLastUploadSuccess(null);
    setActiveJobId(null); 
    setJobStatus('idle');
    setProcessedCount(0);
    setTotalCount(0);
    setJobErrorMessage(null);
    setCurrentFileName(file.name);

    let insertedFileId = null; 

    try {
      setJobStatus('pending_db');
      
      const catalogName = file.name.split('.').slice(0, -1).join('.') || `catalog_${Date.now()}`;
      const fileInsertData = {
          mime_type: file.type || 'application/octet-stream', 
          catalog: catalogName,  
          doc_type: docType,     
      };

      console.log("Inserting file record:", fileInsertData);
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
          body: JSON.stringify({ filename: file.name, file_id: insertedFileId }),
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

      console.log('File upload complete. Waiting for processing job to start...');
      setJobStatus('queued');
      
      let attempts = 0;
      let jobData = null;
      while (attempts < 5 && !jobData) {
         await new Promise(resolve => setTimeout(resolve, 1500));
         console.log(`Attempt ${attempts + 1} to fetch job ID for file ID ${insertedFileId}`);
         const { data, error } = await supabase
             .from('processing_queue')
             .select('id, status, processed_row_count, total_row_count, error_message')
             .eq('file_id', insertedFileId)
             .order('created_at', { ascending: false })
             .limit(1)
             .maybeSingle();
         
         if (error) {
            console.error("Error fetching initial job status:", error);
            break; 
         }
         if (data) {
            jobData = data;
         }
         attempts++;
      }

      if (jobData) {
         console.log("Found initial job data:", jobData);
         setActiveJobId(jobData.id);
         setJobStatus(jobData.status);
         setProcessedCount(jobData.processed_row_count || 0);
         setTotalCount(jobData.total_row_count || 0);
         setJobErrorMessage(jobData.error_message || null);
      } else {
         console.warn(`Could not find processing job for file_id ${insertedFileId} after ${attempts} attempts.`);
         setLastUploadError('File uploaded, but could not track processing status.');
      }

    } catch (error) {
      console.error('Overall handleFileUpload error:', error);
      setLastUploadError(error.message || 'An unexpected error occurred during upload.');
      setIsUploading(false);
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
         if (!activeJobId && jobStatus !== 'processing' && jobStatus !== 'pending' && jobStatus !== 'queued') {
             setIsUploading(false);
         }
    }
  };

  const progressPercent = totalCount > 0 ? Math.round((processedCount / totalCount) * 100) : 0;

  let displayStatus = 'idle';
  let displayMessage = 'Upload a file to begin.';

  if (isUploading || activeJobId) {
      switch (jobStatus) {
          case 'pending_db':
          case 'requesting_url':
          case 'uploading':
              displayStatus = 'uploading';
              displayMessage = 'Uploading...';
              break;
          case 'queued':
          case 'pending':
              displayStatus = 'processing';
              displayMessage = `Queued: ${currentFileName} - Waiting to process...`;
              break;
          case 'processing':
              displayStatus = 'processing';
              displayMessage = `Processing: ${currentFileName} (${processedCount} / ${totalCount > 0 ? totalCount : '?'} rows)`;
              break;
          case 'completed':
              displayStatus = 'success';
              displayMessage = lastUploadSuccess || `Successfully processed ${currentFileName}.`;
              break;
          case 'failed':
              displayStatus = 'error';
              displayMessage = jobErrorMessage || `Failed to process ${currentFileName}.`;
              break;
           case 'error':
               displayStatus = 'error';
               displayMessage = lastUploadError || 'An error occurred.';
               break;
          default:
              displayStatus = 'idle';
              displayMessage = 'Ready to upload.';
      }
  } else if (lastUploadSuccess) {
       displayStatus = 'success';
       displayMessage = lastUploadSuccess;
  } else if (lastUploadError) {
       displayStatus = 'error';
       displayMessage = lastUploadError;
  }

  return (
    <main className="container mx-auto p-4">
      <h1 className="text-2xl font-bold mb-6">Upload Royalty Data</h1>

      <div className="mb-4">
        <Label className="mb-2 block font-medium">1. Select Document Type:</Label>
        <RadioGroup defaultValue="evaluation" value={docType} onValueChange={setDocType} className="flex space-x-4">
          <div className="flex items-center space-x-2">
            <RadioGroupItem value="evaluation" id="r1" />
            <Label htmlFor="r1">Evaluation Data</Label>
          </div>
          <div className="flex items-center space-x-2">
            <RadioGroupItem value="reference" id="r2" />
            <Label htmlFor="r2">Reference Material</Label>
          </div>
        </RadioGroup>
        <p className="text-xs text-muted-foreground mt-1">
          {docType === 'evaluation' 
            ? 'Data for the current valuation analysis (e.g., royalty statement CSV/XLSX).' 
            : 'Background context, historical data, or methodology documents (e.g., reports as PDF).'}
        </p>
      </div>

      <Label className="mb-2 block font-medium">2. Upload File:</Label>
      <FileDrop onFileDrop={handleFileUpload} disabled={isUploading && jobStatus !== 'completed' && jobStatus !== 'failed' && jobStatus !== 'error'} /> 
      
      {(isUploading || activeJobId || lastUploadError || lastUploadSuccess) && (
        <div className="mt-4 space-y-3">
          {(displayStatus === 'processing' || (displayStatus === 'success' && !lastUploadSuccess) || (displayStatus === 'error' && !lastUploadError && activeJobId) ) && totalCount > 0 && (
             <div className="space-y-1">
                <Progress value={progressPercent} className="w-full" />
                <p className="text-sm text-muted-foreground text-center">{progressPercent}% complete</p>
             </div>
          )}

           <Alert variant={displayStatus === 'error' ? 'destructive' : (displayStatus === 'success' ? 'default' : 'default')} 
                  className={`${displayStatus === 'processing' ? 'border-blue-300' : ''} ${displayStatus === 'success' ? 'border-green-300' : ''}`}>
               {displayStatus === 'error' && <Terminal className="h-4 w-4" />} 
               <AlertTitle>
                   {displayStatus === 'uploading' && 'Uploading...'}
                   {displayStatus === 'processing' && 'Processing File'}
                   {displayStatus === 'success' && 'Complete'}
                   {displayStatus === 'error' && 'Error'}
                   {displayStatus === 'idle' && 'Status'}
               </AlertTitle>
               <AlertDescription>
                   {displayMessage}
                   {(displayStatus === 'uploading' || (displayStatus === 'processing' && totalCount === 0)) && <span className="ml-1 animate-pulse">...</span>} 
               </AlertDescription>
           </Alert>
        </div>
      )}
    </main>
  );
} 