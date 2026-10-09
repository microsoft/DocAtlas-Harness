# Prototype source fixture

`sample-report.pdf.base64` preserves the exact bytes of the six-page synthetic demonstration document
`DocAtlas-Harness/data/sample_report.pdf`, SHA-256
`161ea6a246e2520ec26795013d24a9deb8f60f471acd0cdf7ea273a43a6e8fb4`.

This is an example Widget division report, not a real company's financial disclosure. It is copied as text so the demo
can build without the independently versioned, ignored downstream checkout. The preparation script verifies its hash
and decodes the original PDF into ignored public assets. The demo does not reconstruct a PDF from its scripted answers.

Fixture statements are checked against the PDF. Citation rectangles are resolved at runtime against PDF.js's real text
layer, not guessed/hard-coded boxes. User-selected local PDFs never receive these sample-document citations.
