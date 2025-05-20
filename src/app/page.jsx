'use client';

import { useState, useEffect, useRef } from 'react';
import { ChatWindow } from "@/components/ChatWindow";
// import { TracePanel } from "@/components/TracePanel"; // Included within ChatWindow layout now
import { Button } from "@/components/ui/button";
import { generateExcelExport, generateMarkdownExport } from '@/lib/exportUtils';
import { saveAs } from 'file-saver';
// import { Input } from "@/components/ui/input"; // No longer needed here
import { Label } from "@/components/ui/label";
import { 
    Select, 
    SelectContent, 
    SelectItem, 
    SelectTrigger, 
    SelectValue 
} from "@/components/ui/select";
// import { Header } from '@/components/Header'; // Remove Header import from page

export default function DashboardPage() {
  // State for catalogs: Store array of { catalog: string, client_name: string }
  const [availableCatalogs, setAvailableCatalogs] = useState([]); 
  const [selectedCatalog, setSelectedCatalog] = useState(''); // Stores the catalog ID string
  const [isLoadingCatalogs, setIsLoadingCatalogs] = useState(true);
  const [catalogError, setCatalogError] = useState(null);
  const chatWindowRef = useRef(null); // Add ref for ChatWindow

  // Fetch catalogs on component mount
  useEffect(() => {
    const fetchCatalogs = async () => {
      setIsLoadingCatalogs(true);
      setCatalogError(null);
      try {
        const response = await fetch('/api/catalogs'); // Use the new API route
        if (!response.ok) {
          const errData = await response.json();
          throw new Error(errData.error || 'Failed to fetch catalogs');
        }
        const data = await response.json();
        // Assuming data is [{ catalog: '...', client_name: '...' }, ...]
        const catalogsData = Array.isArray(data) ? data.filter(c => c.catalog && c.client_name) : [];
        console.log("Catalogs data received:", catalogsData);
        setAvailableCatalogs(catalogsData);
        
        // Set the first catalog ID as default if available and none selected
        if (catalogsData.length > 0 && !selectedCatalog) {
             setSelectedCatalog(catalogsData[0].catalog); // Set the ID
        }
      } catch (error) {
        console.error("Error fetching catalogs:", error);
        setCatalogError(error.message);
        setAvailableCatalogs([]); // Clear catalogs on error
      } finally {
        setIsLoadingCatalogs(false);
      }
    };

    fetchCatalogs();
  // eslint-disable-next-line react-hooks/exhaustive-deps 
  }, []); // Dependency array remains empty

  const handleExportExcel = async () => {
    console.log("Exporting Excel...");
    if (chatWindowRef.current?.getExportData) {
      const exportData = chatWindowRef.current.getExportData();
      if (!exportData.messages?.length) {
          alert("No chat history to export.");
          return;
      }
      try {
          const blob = await generateExcelExport(exportData);
          saveAs(blob, `valuation-export-${Date.now()}.xlsx`);
      } catch (error) {
          console.error("Excel export failed:", error);
          alert("Failed to generate Excel export. See console for details.");
      }
    } else {
        alert("Cannot access chat data for export.");
    }
  };

  const handleExportMarkdown = async () => {
    console.log("Exporting Markdown...");
    if (chatWindowRef.current?.getExportData) {
        const exportData = chatWindowRef.current.getExportData();
        if (!exportData.messages?.length) {
            alert("No chat history to export.");
            return;
        }
        try {
            const blob = await generateMarkdownExport(exportData);
            saveAs(blob, `valuation-memo-${Date.now()}.md`);
        } catch (error) {
            console.error("Markdown export failed:", error);
            alert("Failed to generate Markdown export. See console for details.");
        }
    } else {
        alert("Cannot access chat data for export.");
    }
  };

  return (
    // Remove outer div and Header component from page level
    // <div className="flex flex-col h-screen">
    //   <Header /> 
      <main className="flex-grow p-4 md:p-6 lg:p-8 flex flex-col space-y-4">
        {/* Catalog Selector */}
        <div className="w-full max-w-xs space-y-2">
           <Label htmlFor="catalog-select">Select Catalog:</Label>
           <Select 
             value={selectedCatalog}
             onValueChange={setSelectedCatalog}
             disabled={isLoadingCatalogs || availableCatalogs.length === 0}
           >
             <SelectTrigger id="catalog-select" className="w-full">
               <SelectValue placeholder={isLoadingCatalogs ? "Loading..." : (availableCatalogs.length === 0 ? "No catalogs found" : "Select a catalog")} >
                  {selectedCatalog 
                    ? availableCatalogs.find(c => c.catalog === selectedCatalog) + ' - ' + selectedCatalog
                    : (isLoadingCatalogs ? "Loading..." : (availableCatalogs.length === 0 ? "No catalogs found" : "Select a catalog"))}
               </SelectValue>
             </SelectTrigger>
             <SelectContent>
               {!isLoadingCatalogs && availableCatalogs.length > 0 ? (
                 availableCatalogs.map((item) => (
                   <SelectItem key={item.catalog} value={item.catalog}>
                     {item.client_name} - {item.catalog}
                   </SelectItem>
                 ))
               ) : (
                 <SelectItem value="loading" disabled>
                   {isLoadingCatalogs ? "Loading..." : "No processed catalogs available"}
                 </SelectItem>
               )}
             </SelectContent>
           </Select>
           {catalogError && <p className="text-xs text-red-600">Error loading catalogs: {catalogError}</p>}
           <p className="text-xs text-muted-foreground">
             Select the dataset you want to query.
           </p>
        </div>

        {/* Always render ChatWindow, passing the selectedCatalog (which might be empty) */}
        {/* The ChatWindow component itself will handle showing the upload prompt if catalog is falsy */}
        <div className="flex-grow min-h-0"> {/* Added flex-grow and min-h-0 here */}
           <ChatWindow 
             ref={chatWindowRef} 
             key={selectedCatalog || 'empty'} // Use a key to reset when catalog changes OR becomes empty 
             catalog={selectedCatalog} // Pass the potentially empty selectedCatalog
             clientName={availableCatalogs.find(c => c.catalog === selectedCatalog)?.client_name || ''} // Pass client name or empty
             availableCatalogs={availableCatalogs}
             initialMessages={selectedCatalog ? [
                {
                  id: 'welcome',
                  role: 'assistant',
                  content: `Ready to answer questions about the **${availableCatalogs.find(c => c.catalog === selectedCatalog) || selectedCatalog}** catalog.`,
                },
              ] : []} // Pass welcome message only if catalog selected
           />
        </div>

        {/* <div className="flex space-x-2 shrink-0">
           <Button variant="outline" onClick={handleExportExcel} disabled={!selectedCatalog || isLoadingCatalogs}>Download Excel Valuation</Button>
           <Button variant="outline" onClick={handleExportMarkdown} disabled={!selectedCatalog || isLoadingCatalogs}>Download Markdown Memo</Button>
        </div> */}
      </main>
    // </div>
  );
} 