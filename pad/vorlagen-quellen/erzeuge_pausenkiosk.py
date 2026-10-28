import random, datetime, sys
random.seed(900)
schueler = [
 # id, vorname, nachname, klasse, guthaben
 ("Lena","Huber","9a"),("Jonas","Wagner","9a"),("Mia","Bauer","9a"),("Leon","Maier","9a"),
 ("Emma","Schmid","9a"),("Paul","Hofmann","9a"),("Hannah","Fischer","9a"),("Elias","Weber","9a"),
 ("Sophie","Brunner","9b"),("Felix","Gruber","9b"),("Marie","Lang","9b"),("Noah","Wimmer","9b"),
 ("Lea","Steiner","9b"),("Luis","Moser","9b"),("Emilia","Berger","9b"),("Ben","Kaiser","9b"),
 ("Anna","Seidl","9c"),("Maximilian","Winkler","9c"),("Lina","Pichler","9c"),("Finn","Reiter","9c"),
 ("Clara","Fuchs","9c"),("Moritz","Ertl","9c"),("Ella","Graf","9c"),("Tim","Lechner","9c"),
]
produkte = [
 # name, kategorie, preis, kalorien, vegan
 ("Butterbreze","Gebäck",1.20,280,False),
 ("Laugenstange","Gebäck",0.90,230,True),
 ("Leberkässemmel","Warm",2.80,520,False),
 ("Pizzaschnecke","Warm",1.80,340,False),
 ("Käsesemmel","Belegt",2.20,390,False),
 ("Gemüse-Wrap","Belegt",3.20,410,True),
 ("Apfel","Obst",0.50,70,True),
 ("Banane","Obst",0.60,105,True),
 ("Schokocroissant","Süßes",1.50,360,False),
 ("Müsliriegel","Süßes",1.00,190,True),
 ("Donut","Süßes",1.30,300,False),
 ("Wasser","Getränk",0.80,0,True),
 ("Apfelschorle","Getränk",1.20,120,True),
 ("Kakao","Getränk",1.40,210,False),
 ("Eistee","Getränk",1.30,160,True),
 ("Spezi","Getränk",1.50,200,True),
]
# Vorlieben je Klasse (Gewichte), damit Auswertungen etwas zeigen
fav = {"9a":{9:4,1:3,13:3,7:2}, "9b":{3:7,16:3,4:2,11:2}, "9c":{6:4,2:3,15:3,12:3,8:2}}
days=[]
d=datetime.date(2026,10,12)
while len(days)<10:
    if d.weekday()<5: days.append(d)
    d+=datetime.timedelta(days=1)
kauf=[]
for day in days:
    for sid,(vn,nn,kl) in enumerate(schueler, start=1):
        if vn=="Tim": continue          # Tim bringt immer eine Brotzeit mit
        for pause in (1,2):
            p = 0.45 if pause==1 else 0.3
            if vn in ("Felix","Ben"): p += 0.25     # Stammkunden
            if random.random() < p:
                w=[1.0]*len(produkte)
                for pid,g in fav[kl].items(): w[pid-1]+=g
                pid=random.choices(range(1,len(produkte)+1), weights=w)[0]
                anzahl = 2 if random.random()<0.08 else 1
                kauf.append((sid,pid,day.isoformat(),pause,anzahl))
q=lambda s:"'"+s.replace("'","''")+"'"
out=[]
out.append("-- Pausenkiosk: kleine Beispieldatenbank für QPad (Demo-Lernpfad)")
out.append("-- Schüler/innen der 9. Klassen kaufen in den Pausen am Schulkiosk ein (12. bis 23. Oktober 2026).\n")
out.append("""create table schueler (
   id integer primary key,
   vorname varchar(30) not null,
   nachname varchar(30) not null,
   klasse varchar(3) not null,
   guthaben decimal(5,2) not null
);
""")
out.append("""create table produkt (
   id integer primary key,
   name varchar(40) not null,
   kategorie varchar(20) not null,
   preis decimal(4,2) not null,
   kalorien integer not null,
   vegan boolean not null
);
""")
out.append("""create table kauf (
   id integer primary key,
   schueler_id integer not null references schueler(id),
   produkt_id integer not null references produkt(id),
   datum date not null,
   pause integer not null,
   anzahl integer not null
);
""")
random.seed(7)
rows=[]
for i,(vn,nn,kl) in enumerate(schueler, start=1):
    g = round(random.choice([0.5,1.2,2.4,3.0,4.5,5.0,6.8,7.5,8.2,10.0,12.5,15.0,20.0,3.6,9.1]),2)
    rows.append(f"({i}, {q(vn)}, {q(nn)}, {q(kl)}, {g:.2f})")
out.append("insert into schueler (id, vorname, nachname, klasse, guthaben) values\n" + ",\n".join(rows)+";\n")
rows=[f"({i}, {q(n)}, {q(k)}, {p:.2f}, {c}, {'true' if v else 'false'})" for i,(n,k,p,c,v) in enumerate(produkte, start=1)]
out.append("insert into produkt (id, name, kategorie, preis, kalorien, vegan) values\n" + ",\n".join(rows)+";\n")
rows=[f"({i}, {s}, {p}, {q(d)}, {pa}, {a})" for i,(s,p,d,pa,a) in enumerate(kauf, start=1)]
out.append("insert into kauf (id, schueler_id, produkt_id, datum, pause, anzahl) values\n" + ",\n".join(rows)+";\n")
open(sys.argv[1],"w").write("\n".join(out))
print(len(kauf),"Käufe")
