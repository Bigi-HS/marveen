from openpyxl import load_workbook
from openpyxl.styles import PatternFill, Font
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer
from reportlab.lib.styles import ParagraphStyle

import sys
SRC=sys.argv[1] if len(sys.argv)>1 else 'store/kahoot-lego-v3.xlsx'
PDF=sys.argv[2] if len(sys.argv)>2 else SRC.rsplit('.',1)[0]+'.pdf'
TITLE=sys.argv[3] if len(sys.argv)>3 else 'Kahoot Kvíz'
wb=load_workbook(SRC); ws=wb.active
rows=list(ws.iter_rows(values_only=True))
data=[]
for r in rows[1:]:
    if not r[0]: continue
    q=str(r[0]); ans=[r[1],r[2],r[3],r[4]]; t=r[5]
    ci=int(str(r[6]).split(',')[0].split(';')[0].strip())-1
    data.append([q,ans,t,ans[ci]])

# balanced round-robin target position, respecting answer count
rr=[0,1,2,3]; k=0
out=[]
for q,ans,t,ctext in data:
    present=[i for i in range(4) if ans[i] is not None]
    others=[ans[i] for i in present if ans[i]!=ctext]
    n=len(present)
    # choose target among present positions, cycling for balance
    target=rr[k%4]; 
    while target not in present:
        k+=1; target=rr[k%4]
    k+=1
    newans=[None,None,None,None]
    newans[target]=ctext
    oi=0
    for p in present:
        if p==target: continue
        newans[p]=others[oi]; oi+=1
    out.append((q,newans,t,target))
data=out
from collections import Counter
print('New correct positions:', Counter(d[3]+1 for d in data))

green=PatternFill(start_color='C6EFCE',end_color='C6EFCE',fill_type='solid')
gbold=Font(color='006100',bold=True)
for i,(q,ans,t,ci) in enumerate(data,start=2):
    ws.cell(row=i,column=1,value=q)
    for j in range(4):
        c=ws.cell(row=i,column=j+2,value=ans[j])
        c.fill=green if j==ci else PatternFill(fill_type=None)
        c.font=gbold if j==ci else Font(color='000000')
    ws.cell(row=i,column=6,value=t); ws.cell(row=i,column=7,value=str(ci+1))
wb.save(SRC); print('XLSX saved:',SRC)

pdfmetrics.registerFont(TTFont('DejaVu','/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'))
pdfmetrics.registerFont(TTFont('DejaVu-Bold','/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'))
qs=ParagraphStyle('q',fontName='DejaVu-Bold',fontSize=10,leading=13,textColor=colors.HexColor('#1a1a2e'))
astyle=ParagraphStyle('a',fontName='DejaVu',fontSize=9,leading=12)
acor=ParagraphStyle('ac',fontName='DejaVu-Bold',fontSize=9,leading=12,textColor=colors.black)
title=ParagraphStyle('t',fontName='DejaVu-Bold',fontSize=18,leading=22,textColor=colors.HexColor('#0b6e4f'))
sub=ParagraphStyle('s',fontName='DejaVu',fontSize=10,leading=14,textColor=colors.HexColor('#555555'))
doc=SimpleDocTemplate(PDF,pagesize=A4,topMargin=15*mm,bottomMargin=15*mm,leftMargin=14*mm,rightMargin=14*mm)
el=[Paragraph(TITLE,title),
    Paragraph(f'{len(data)} kérdés · a helyes válasz zöld háttérrel kiemelve · Kahoot import-kész',sub),Spacer(1,6*mm)]
gbg=colors.HexColor('#C6EFCE'); letters=['A','B','C','D']
for n,(q,ans,t,ci) in enumerate(data,1):
    tr=[[Paragraph(f'{n}. {q}',qs),'']]
    cs=[('SPAN',(0,0),(1,0)),('FONTNAME',(0,0),(-1,-1),'DejaVu'),('VALIGN',(0,0),(-1,-1),'MIDDLE'),
        ('TOPPADDING',(0,0),(-1,-1),3),('BOTTOMPADDING',(0,0),(-1,-1),3),
        ('LEFTPADDING',(0,0),(-1,-1),6),('RIGHTPADDING',(0,0),(-1,-1),6),
        ('LINEBELOW',(0,0),(-1,0),0.4,colors.HexColor('#cccccc'))]
    ri=1
    for j in range(4):
        if ans[j] is None: continue
        isc=(j==ci)
        tr.append([Paragraph(f'{letters[j]}.  {ans[j]}',acor if isc else astyle),''])
        cs.append(('SPAN',(0,ri),(1,ri)))
        if isc: cs.append(('BACKGROUND',(0,ri),(1,ri),gbg))
        ri+=1
    tb=Table(tr,colWidths=[150*mm,20*mm]); tb.setStyle(TableStyle(cs))
    el.append(tb); el.append(Spacer(1,3*mm))
doc.build(el); print('PDF saved:',PDF)
