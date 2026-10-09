/** Synthetic uncompressed PDF bytes for real parser/browser tests; no private source material. */
export function longPdf(options: { embeddedToc?: boolean, typography?: boolean, nestedToc?: boolean } = {}): Buffer {
  const objects: string[] = []
  const add = (value: string) => { objects.push(value); return objects.length }
  const catalog = add(''), pages = add(''), font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'), pageIds: number[] = []
  for (let page = 1; page <= 6; page++) {
    const lines = [`BT /F1 18 Tf 50 750 Td (Section ${page}: Experiment Results) Tj /F1 11 Tf`]
    if (options.typography && page === 2) lines.push('0 -24 Td (Q4 baseline BERT) Tj /F1 7 Tf 4 Ts (36) Tj /F1 11 Tf 0 Ts ( performs well.) Tj')
    for (let line = 0; line < 20; line++) lines.push(`0 -24 Td (Experiment ${page} observation ${line + 1}: calibrated sensors record repeatable measurements.) Tj`)
    lines.push('ET')
    const stream = lines.join('\n'), content = add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`)
    pageIds.push(add(`<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`))
  }
  let outlines = ''
  if (options.embeddedToc !== false) {
    const root = add(''), entries = pageIds.map(() => add(''))
    const groups = options.nestedToc ? [add(''), add('')] : []
    for (let index = 0; index < entries.length; index++) {
      if (options.nestedToc) {
        const first = index % 3 === 0, last = index % 3 === 2
        objects[entries[index]! - 1] = `<< /Title (Section ${index + 1}) /Parent ${groups[Math.floor(index / 3)]} 0 R /Dest [${pageIds[index]} 0 R /FitH 792]${first ? '' : ` /Prev ${entries[index - 1]} 0 R`}${last ? '' : ` /Next ${entries[index + 1]} 0 R`} >>`
        continue
      }
      objects[entries[index]! - 1] = `<< /Title (Section ${index + 1}) /Parent ${root} 0 R /Dest [${pageIds[index]} 0 R /FitH 792]${index ? ` /Prev ${entries[index - 1]} 0 R` : ''}${index + 1 < entries.length ? ` /Next ${entries[index + 1]} 0 R` : ''} >>`
    }
    if (options.nestedToc) for (let index = 0; index < groups.length; index++) {
      objects[groups[index]! - 1] = `<< /Title (Part ${index + 1}) /Parent ${root} 0 R /Dest [${pageIds[index * 3]} 0 R /FitH 792] /First ${entries[index * 3]} 0 R /Last ${entries[index * 3 + 2]} 0 R /Count 3${index ? ` /Prev ${groups[0]} 0 R` : ` /Next ${groups[1]} 0 R`} >>`
    }
    objects[root - 1] = `<< /Type /Outlines /First ${(options.nestedToc ? groups : entries)[0]} 0 R /Last ${(options.nestedToc ? groups : entries).at(-1)} 0 R /Count ${entries.length + groups.length} >>`
    outlines = ` /Outlines ${root} 0 R`
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pages} 0 R${outlines} >>`
  objects[pages - 1] = `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] >>`
  let output = '%PDF-1.4\n', offsets = [0]
  for (let index = 0; index < objects.length; index++) { offsets.push(Buffer.byteLength(output)); output += `${index + 1} 0 obj\n${objects[index]}\nendobj\n` }
  const xref = Buffer.byteLength(output)
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(output)
}
