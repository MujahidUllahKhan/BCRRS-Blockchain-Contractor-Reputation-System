#!/usr/bin/env python3
"""
BCRRS CPEC Case Study Simulation  v3
=====================================
Key fix: contractors can have projects in DIFFERENT categories and
widely varying contract values, so complexity weights (alpha, beta,
gamma) produce genuinely different weighted averages when perturbed.
Target: ~200 milestones.
"""
import numpy as np, csv, os
from collections import defaultdict

SEED = 42
rng = np.random.default_rng(SEED)

N = 50
CATS = ["INFRASTRUCTURE","COMMERCIAL","RESIDENTIAL"]
CT = {"INFRASTRUCTURE":3, "COMMERCIAL":2, "RESIDENTIAL":1}
TIERS = ["PK-KP","PK-PB"]
DMAX = 180*86400; TMAX = 36; VREF = 1e6
A0,B0,G0 = 0.50,0.30,0.20
WT = np.array([0.30,0.25,0.25,0.20])

def gen():
    cs,ps,ms = [],[],[]
    pid=mid=0
    for i in range(N):
        cid=f"C-{i+1:03d}"
        # Primary category
        pcat = CATS[0] if i<20 else CATS[1] if i<35 else CATS[2]
        tier = TIERS[i%2]
        if i<10:   qb=rng.uniform(0.82,0.97)
        elif i<40: qb=rng.uniform(0.50,0.82)
        else:      qb=rng.uniform(0.20,0.48)
        cs.append(dict(id=cid, primary_cat=pcat, tier=tier, qb=qb))

        # 1-2 projects, some cross-category
        np_ = rng.integers(1,3)  # 1 or 2 projects → ~100 projects total
        for k in range(np_):
            pid += 1
            # 30% chance of secondary category project
            if k > 0 and rng.random() < 0.3:
                cat = rng.choice([c for c in CATS if c != pcat])
            else:
                cat = pcat

            if cat=="INFRASTRUCTURE":
                val,dur = rng.uniform(5e6,200e6), rng.uniform(18,60)
            elif cat=="COMMERCIAL":
                val,dur = rng.uniform(2e6,50e6), rng.uniform(12,36)
            else:
                val,dur = rng.uniform(500_000,10e6), rng.uniform(4,24)

            proj=dict(pid=f"P-{pid:03d}",cid=cid,cat=cat,tier=tier,
                      val=val,dur=dur,tc=CT[cat])
            ps.append(proj)

            # 2-3 milestones per project → ~200 total
            nm = rng.integers(2,4)
            for j in range(nm):
                mid+=1
                ot = rng.random()<qb
                dl = 0 if ot else int(rng.uniform(1,120)*86400)
                qs = float(np.clip(rng.normal(qb*100,10),0,100))
                ms.append(dict(mid=f"MS-{mid:04d}",pid=proj["pid"],
                    cid=cid,qs=round(qs,2),
                    mc=bool(rng.random()<qb),
                    df=bool(rng.random()>qb),
                    ot=bool(ot),dl=dl))
    return cs,ps,ms

def proj_met(ps,ms):
    mbp=defaultdict(list)
    for m in ms: mbp[m["pid"]].append(m)
    pm={}
    for p in ps:
        ml=mbp[p["pid"]]; n=len(ml)
        if not n: continue
        ot=sum(1 for m in ml if m["ot"])
        ad=np.mean([m["dl"] for m in ml])
        spi=float(np.clip((ot/n)*(1-ad/DMAX),0,1))
        dds=float(np.mean([m["qs"] for m in ml]))
        mcr=sum(1 for m in ml if m["mc"])/n
        dc=sum(1 for m in ml if m["df"])
        fci=float(np.clip(1-dc/n,0,1))
        pm[p["pid"]]=dict(cid=p["cid"],spi=spi,dds=dds,mcr=mcr,fci=fci,
            val=p["val"],tc=p["tc"],dur=p["dur"],nm=n,dc=dc,cat=p["cat"])
    return pm

def cwt(v,t,d,a,b,g):
    return a*np.log(max(v/VREF,0.01)) + b*t + g*min(d/TMAX,1.0)

def agg(cs,ps,pm,a=A0,b=B0,g=G0):
    pbc=defaultdict(list)
    for p in ps:
        if p["pid"] in pm: pbc[p["cid"]].append(pm[p["pid"]])
    res=[]
    for c in cs:
        pl=pbc[c["id"]]
        if not pl: continue
        ws=[]
        for p in pl:
            w=max(cwt(p["val"],p["tc"],p["dur"],a,b,g),0.1)
            ws.append(w)
        W=np.array(ws); W/=W.sum()
        spi=float(np.dot(W,[p["spi"] for p in pl]))
        dds=float(np.dot(W,[p["dds"] for p in pl]))
        mcr=float(np.dot(W,[p["mcr"] for p in pl]))
        fci=float(np.dot(W,[p["fci"] for p in pl]))
        tm=sum(p["nm"] for p in pl)
        td=sum(p["dc"] for p in pl)
        res.append(dict(id=c["id"],cat=c["primary_cat"],tier=c["tier"],
            spi=round(spi,4),dds=round(dds,2),mcr=round(mcr,4),
            fci=round(fci,4),tm=tm,np_=len(pl),
            dr=round(td/tm,4) if tm else 0,qb=c["qb"]))
    return res

def top(ml,w=WT):
    n=len(ml)
    X=np.array([[m["spi"],m["dds"]/100,m["mcr"],m["fci"]] for m in ml])
    nr=np.sqrt((X**2).sum(0)); nr[nr==0]=1
    V=(X/nr)*w
    Ap,Am=V.max(0),V.min(0)
    Sp=np.sqrt(((V-Ap)**2).sum(1))
    Sm=np.sqrt(((V-Am)**2).sum(1))
    d=Sp+Sm; d[d==0]=1; C=Sm/d
    o=np.argsort(-C)
    return [dict(id=ml[i]["id"],ts=round(float(C[i]),4),rk=r+1,
        spi=ml[i]["spi"],dds=ml[i]["dds"],mcr=ml[i]["mcr"],
        fci=ml[i]["fci"],cat=ml[i]["cat"],tier=ml[i]["tier"],
        dr=ml[i]["dr"]) for r,i in enumerate(o)]

def ro(rl):
    rm={r["id"]:r["rk"] for r in rl}
    return [rm[k] for k in sorted(rm)]

def kt(r1,r2):
    n=len(r1);c=d=0
    for i in range(n):
        for j in range(i+1,n):
            p=np.sign(r1[i]-r1[j])*np.sign(r2[i]-r2[j])
            if p>0:c+=1
            elif p<0:d+=1
    dn=n*(n-1)/2
    return round((c-d)/dn,4) if dn else 1.0

def main():
    out=[]
    def log(s=""): print(s); out.append(s)

    log("="*72)
    log("BCRRS CPEC SIMULATION v3"); log("="*72+"\n")

    cs,ps,ms = gen()
    cats=defaultdict(int); tiers=defaultdict(int)
    for c in cs: cats[c["primary_cat"]]+=1; tiers[c["tier"]]+=1

    # Count cross-category projects
    cross = sum(1 for p in ps
                for c in cs if c["id"]==p["cid"] and p["cat"]!=c["primary_cat"])

    log(f"Contractors:     {len(cs)}")
    log(f"Projects:        {len(ps)} ({cross} cross-category)")
    log(f"Milestones:      {len(ms)}")
    log(f"Categories:      {dict(cats)}")
    log(f"Tiers:           {dict(tiers)}\n")

    pm = proj_met(ps,ms)
    met = agg(cs,ps,pm)
    for m in met: m["comp"]=round(m["spi"]*(m["dds"]/100)*m["mcr"],4)

    ranked = top(met)
    bro = ro(ranked)

    log("-"*80+"\nTOPSIS RANKING\n"+"-"*80)
    log(f"{'Rk':<4} {'ID':<7} {'T':>6} {'SPI':>6} {'DDS':>5} "
        f"{'MCR':>5} {'FCI':>5} {'DR':>5} {'Cat':<15} {'Tier'}")
    log("-"*72)
    for r in ranked:
        log(f"{r['rk']:<4} {r['id']:<7} {r['ts']:>6.4f} "
            f"{r['spi']:>6.4f} {r['dds']:>5.1f} {r['mcr']:>5.3f} "
            f"{r['fci']:>5.3f} {r['dr']:>5.2f} {r['cat']:<15} {r['tier']}")

    log("\n"+"-"*72+"\nTOP 5\n"+"-"*72)
    for r in ranked[:5]:
        log(f"  #{r['rk']} {r['id']} T={r['ts']:.4f} "
            f"SPI={r['spi']:.4f} DDS={r['dds']:.1f} MCR={r['mcr']:.3f} FCI={r['fci']:.3f}")

    log("\n"+"-"*72+"\nBOTTOM DECILE\n"+"-"*72)
    bot=ranked[45:]; fl=[]
    for r in bot:
        rs=[]
        if r["dr"]>0.30: rs.append(f"DR={r['dr']:.2f}")
        if r["mcr"]<0.6: rs.append(f"MCR={r['mcr']:.3f}")
        if rs: fl.append(r); log(f"  FLAGGED {r['id']} (Rk{r['rk']}): {', '.join(rs)}")
        else: log(f"  {r['id']} (Rk{r['rk']}): OK")
    log(f"  → {len(fl)}/{len(bot)} flagged\n")

    # Disputes
    mid_c=[ranked[14],ranked[19],ranked[24]]
    disps,corrs=[],[]
    did=0; dset=set()
    for i,mc in enumerate(mid_c):
        nd=3 if i<2 else 2
        for j in range(nd):
            did+=1; up=did<=4
            disps.append(dict(d=f"D-{did:03d}",c=mc["id"],
                              s="UPHELD" if up else "REJECTED"))
            dset.add(mc["id"])
            if up:
                corrs.append(dict(c=mc["id"],
                    db=float(rng.uniform(4,10)),fix=True))

    log("-"*72+"\nDISPUTES\n"+"-"*72)
    for d in disps: log(f"  {d['d']}: {d['c']} → {d['s']}")
    uph=sum(1 for d in disps if d["s"]=="UPHELD")
    log(f"  → {len(dset)} contractors, {uph} upheld, {len(disps)-uph} rejected\n")

    # Corrections
    cm=defaultdict(list)
    for c in corrs: cm[c["c"]].append(c)
    cmet=[]
    for m in met:
        mc=dict(m)
        if m["id"] in cm:
            for c in cm[m["id"]]:
                mc["dds"]=round(min(mc["dds"]+c["db"],100),2)
                t=mc["tm"]
                mc["mcr"]=round(min((mc["mcr"]*t+1)/t,1.0),4)
        cmet.append(mc)
    cr=top(cmet); cro_=ro(cr)
    orm={r["id"]:r["rk"] for r in ranked}
    crm={r["id"]:r["rk"] for r in cr}

    log("-"*72+"\nDRC RANK IMPACT\n"+"-"*72)
    imps=[]
    for cid in sorted(set(c["c"] for c in corrs)):
        o,c_=orm[cid],crm[cid]; imps.append(o-c_)
        log(f"  {cid}: Rk {o} → {c_}  ({o-c_:+d})")

    # Stability
    tp=kt(bro,ro(top([dict(m,dds=round(float(np.clip(
        m["dds"]+rng.uniform(-5,5),0,100)),2)) for m in met])))
    tc=kt(bro,cro_)
    log(f"\n"+"-"*72+"\nSTABILITY\n"+"-"*72)
    log(f"  τ (±5pt perturbation): {tp}")
    log(f"  τ (DRC corrections):   {tc}\n")

    # Grid
    perts=[("Baseline","--",A0,B0,G0),("alpha","+20%",.60,.30,.20),
        ("alpha","-20%",.40,.30,.20),("beta","+20%",.50,.36,.20),
        ("beta","-20%",.50,.24,.20),("gamma","+20%",.50,.30,.24),
        ("gamma","-20%",.50,.30,.16)]
    log("-"*72+"\nGRID SENSITIVITY\n"+"-"*72)
    log(f"{'P':<10} {'D':<6} {'α':>5} {'β':>5} {'γ':>5} {'τ':>7}")
    log("-"*42)
    gts=[]
    for p,d,a,b,g in perts:
        r2=top(agg(cs,ps,pm,a,b,g)); t=kt(bro,ro(r2)); gts.append(t)
        log(f"{p:<10} {d:<6} {a:>5.2f} {b:>5.2f} {g:>5.2f} {t:>7.3f}")
    mg=min(gts)
    log(f"  → Min τ: {mg}\n")

    # MC
    log("-"*72+"\nMONTE CARLO (500)\n"+"-"*72)
    mts=[]
    for _ in range(500):
        a,b,g=rng.uniform(0.2,0.8),rng.uniform(0.1,0.5),rng.uniform(0.1,0.4)
        r2=top(agg(cs,ps,pm,a,b,g)); mts.append(kt(bro,ro(r2)))
    ar=np.array(mts)
    log(f"  Mean τ:       {ar.mean():.3f}")
    log(f"  Std τ:        {ar.std():.3f}")
    log(f"  Min τ:        {ar.min():.3f}")
    log(f"  Max τ:        {ar.max():.3f}")
    log(f"  % < 0.80:     {100*(ar<0.80).mean():.1f}%\n")

    # Top-5 stability
    bt5=set(r["id"] for r in ranked[:5]); allsame=True
    log("-"*72+"\nTOP-5 STABILITY\n"+"-"*72)
    for p,d,a,b,g in perts:
        r2=top(agg(cs,ps,pm,a,b,g))
        t5=set(x["id"] for x in r2[:5])
        same=bt5==t5
        if not same: allsame=False
        log(f"  α={a:.2f} β={b:.2f} γ={g:.2f}: {'SAME' if same else 'CHANGED'}")
    log(f"  → {'YES' if allsame else 'NO'}\n")

    # Summary
    log("="*72+"\nPAPER VALUES\n"+"="*72)
    log(f"  Contractors:        {len(cs)}")
    log(f"  Categories:         {len(cats)}")
    log(f"  Tiers:              {len(tiers)}")
    log(f"  Milestones:         {len(ms)}")
    log(f"  Cross-cat projects: {cross}")
    log(f"  Bottom flagged:     {len(fl)}/{len(bot)}")
    log(f"  Disputes:           {len(disps)} ({uph} upheld, {len(disps)-uph} rej)")
    log(f"  Disputers:          {len(dset)}")
    log(f"  Rank improvements:  {imps}")
    log(f"  τ perturb:          {tp}")
    log(f"  τ DRC:              {tc}")
    log(f"  Grid min τ:         {mg}")
    log(f"  MC mean τ:          {ar.mean():.3f} (std={ar.std():.3f})")
    log(f"  MC min τ:           {ar.min():.3f}")
    log(f"  MC %<0.80:          {100*(ar<0.80).mean():.1f}%")
    log(f"  Top-5 stable:       {'YES' if allsame else 'NO'}")

    odir="/mnt/user-data/outputs"
    os.makedirs(odir,exist_ok=True)
    with open(f"{odir}/cpec_results_report.txt","w") as f:
        f.write("\n".join(out))
    with open(f"{odir}/cpec_contractors.csv","w",newline="") as f:
        w=csv.DictWriter(f,fieldnames=["id","cat","tier","spi","dds",
            "mcr","fci","dr","comp","tm","np_"])
        w.writeheader()
        for m in sorted(met,key=lambda x:x.get("comp",0),reverse=True):
            w.writerow({"id":m["id"],"cat":m["cat"],"tier":m["tier"],
                "spi":m["spi"],"dds":m["dds"],"mcr":m["mcr"],"fci":m["fci"],
                "dr":m["dr"],"comp":m.get("comp"),"tm":m["tm"],"np_":m["np_"]})
    with open(f"{odir}/cpec_milestones.csv","w",newline="") as f:
        w=csv.DictWriter(f,fieldnames=["mid","pid","cid","qs","mc","df","ot","dl"])
        w.writeheader()
        for m in ms: w.writerow(m)
    with open(f"{odir}/cpec_rankings.csv","w",newline="") as f:
        w=csv.DictWriter(f,fieldnames=["rk","id","ts","spi","dds","mcr","fci","cat","tier","dr"])
        w.writeheader()
        for r in ranked: w.writerow(r)
    log(f"\nFiles → {odir}/")

if __name__=="__main__":
    main()
