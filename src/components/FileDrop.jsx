'use client';

import { useCallback } from 'react';
import { useDropzone } from 'react-dropzone';

export function FileDrop({ onFileDrop }) {
  const onDrop = useCallback((acceptedFiles) => {
    if (acceptedFiles.length > 0) {
      onFileDrop(acceptedFiles[0]); // Handle only the first file
    }
  }, [onFileDrop]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'text/csv': ['.csv'],
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
      'application/pdf': ['.pdf'],
    },
    multiple: false,
  });

  return (
    <div
      {...getRootProps()}
      className={`border-2 border-dashed rounded-lg p-10 text-center cursor-pointer transition-colors 
        ${isDragActive ? 'border-blue-500 bg-blue-50' : 'border-gray-300 hover:border-gray-400'}`}
    >
      <input {...getInputProps()} />
      {
        isDragActive ?
          <p>Drop the file here ...</p> :
          <p>Drag 'n' drop a CSV, XLSX, or PDF file here, or click to select</p>
      }
    </div>
  );
} 