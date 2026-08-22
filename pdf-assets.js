export const pdfjsPath = path =>
    `${globalThis.__MOKE_EMBEDDED ? '/readest' : ''}/vendor/pdfjs/${path}`
