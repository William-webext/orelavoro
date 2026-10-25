# Aggiorna l'indice (e i numeri di pagina) del manuale con Microsoft Word e, a richiesta, esporta un PDF.
#   powershell -File docs/tools/update-docx.ps1 -Docx docs/Manuale-Ore-Lavoro.docx [-Pdf docs/Manuale-Ore-Lavoro.pdf]
param(
  [Parameter(Mandatory = $true)][string]$Docx,
  [string]$Pdf = ''
)
$ErrorActionPreference = 'Stop'
$docx = (Resolve-Path $Docx).Path
$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
try {
  $doc = $word.Documents.Open($docx)
  $doc.Repaginate()
  foreach ($toc in $doc.TablesOfContents) { $toc.Update() }
  $doc.Fields.Update() | Out-Null
  $doc.Repaginate()
  foreach ($toc in $doc.TablesOfContents) { $toc.Update() }
  $pages = $doc.ComputeStatistics(2)
  $doc.Save()
  if ($Pdf -ne '') {
    $pdfPath = [System.IO.Path]::GetFullPath($Pdf)
    $doc.ExportAsFixedFormat($pdfPath, 17)
    Write-Host "PDF: $pdfPath"
  }
  Write-Host "Indici aggiornati: $($doc.TablesOfContents.Count); pagine: $pages"
  try { $doc.Close($false) } catch { }
} finally {
  $word.Quit()
}
