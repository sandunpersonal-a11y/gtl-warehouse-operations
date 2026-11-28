async function readPayrollWorkbook(file,sheetName,allSheets=false){
  if(!window.JSZip)throw new Error('Excel reader is unavailable. Check that jszip.min.js was deployed.');
  const zip=await JSZip.loadAsync(await file.arrayBuffer());
  const elements=(root,name)=>Array.from(root.getElementsByTagNameNS('*',name));
  async function xml(path){
    const entry=zip.file(path);
    if(!entry)throw new Error('Missing Excel workbook component '+path+'.');
    const document=new DOMParser().parseFromString(await entry.async('string'),'application/xml');
    if(elements(document,'parsererror').length)throw new Error('Invalid Excel workbook component '+path+'.');
    return document;
  }
  const workbook=await xml('xl/workbook.xml');
  const relations=await xml('xl/_rels/workbook.xml.rels');
  const available=elements(workbook,'sheet');
  const sheets=sheetName?available.filter(sheet=>sheet.getAttribute('name')===sheetName):allSheets?available:available.slice(0,2);
  if(sheetName&&!sheets.length)throw new Error('Missing Excel sheet '+sheetName+'.');
  if(!sheetName&&!allSheets&&sheets.length!==2)throw new Error('Include both payroll tabs as the first two tabs.');
  const relationshipById=new Map(elements(relations,'Relationship').map(item=>[item.getAttribute('Id'),item]));
  const stringValue=node=>elements(node,'t').filter(text=>text.parentNode.localName!=='rPh').map(text=>text.textContent).join('');
  const strings=zip.file('xl/sharedStrings.xml')?elements(await xml('xl/sharedStrings.xml'),'si').map(stringValue):[];
  const tables=[];
  for(const sheet of sheets){
    const name=sheet.getAttribute('name');
    const id=Array.from(sheet.attributes).find(attribute=>attribute.localName==='id')?.value;
    const relationship=relationshipById.get(id);
    if(!relationship?.getAttribute('Type')?.endsWith('/worksheet')||relationship.getAttribute('TargetMode')==='External'){
      throw new Error(name+' is not a payroll worksheet.');
    }
    const target=relationship.getAttribute('Target');
    if(!target)throw new Error('Missing worksheet path for '+name+'.');
    const path=new URL(target,'https://workbook.invalid/xl/workbook.xml').pathname.slice(1);
    const data=await xml(path);
    const rows=[];
    for(const row of elements(data,'row')){
      const position=Number(row.getAttribute('r'))||rows.length+1;
      if(position<1||position>1048576)throw new Error('Invalid worksheet row in '+name+'.');
      const values=[];
      for(const cell of elements(row,'c')){
        const reference=cell.getAttribute('r')?.match(/^([A-Z]{1,3})\d+$/);
        const col=reference?[...reference[1]].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0)-1:values.length;
        const raw=elements(cell,'v')[0]?.textContent;
        const type=cell.getAttribute('t');
        values[col]=type==='inlineStr'?stringValue(cell):
          type==='s'?strings[Number(raw)]:
          raw??(elements(cell,'f').length?'#NO_CACHED_VALUE':'');
      }
      rows[position-1]=Array.from(values,value=>value??'');
    }
    tables.push({name:file.name+' / '+name,rows:Array.from(rows,row=>row??[])});
  }
  return tables;
}
