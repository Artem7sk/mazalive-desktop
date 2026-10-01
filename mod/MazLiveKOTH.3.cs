using System;
using System.IO;
using System.Text;
using System.Linq;
using System.Collections.Generic;
using System.Globalization;
using System.Windows.Forms;
using GTA;
using GTA.Math;
using GTA.Native;

// MAZLIVE KOTH 2.0.0-beta.1 - GTA V Legacy, SHVDN API 3.
// Protocol v2: session-scoped, acknowledged, bounded local file inbox.
public sealed class MazLiveKOTH : Script
{
    class Hazard { public Entity E; public int Until; public string Name; }
    class Pending { public string Action,Name; public int Count; }
    readonly string root = Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"scripts","MazLiveKOTH");
    readonly List<Prop> decks = new List<Prop>();
    readonly List<Hazard> hazards = new List<Hazard>();
    readonly Queue<Pending> pending = new Queue<Pending>();
    readonly Random rng = new Random();
    readonly string session = Guid.NewGuid().ToString("N");
    readonly HashSet<string> seen = new HashSet<string>();
    readonly Queue<string> seenOrder = new Queue<string>();
    int lastAckCleanup, errorAt, modelWaitSince;
    string waitingModel="";
    bool faulted;
    static long UtcMs(){return (long)(DateTime.UtcNow-new DateTime(1970,1,1)).TotalMilliseconds;}
    int Remaining(){return !running?duration:Math.Max(0,duration-(Game.GameTime-startTime)/1000);}
    static void Atomic(string file,string text){File.WriteAllText(file+".tmp",text,new UTF8Encoding(false));if(File.Exists(file))File.Replace(file+".tmp",file,null);else File.Move(file+".tmp",file);}
    void Ack(string id,string outcome,string detail){
        Atomic(Path.Combine(root,"acks",id+".json"),"{\"protocol\":2,\"session\":\""+session+"\",\"id\":\""+id+"\",\"outcome\":\""+outcome+"\",\"detail\":\""+Esc(detail)+"\",\"updatedAt\":"+UtcMs()+"}");
    }
    Vector3 origin = new Vector3(-1200f,-3000f,220f), oldPosition;
    float oldHeading, width, length, total, cosine, sine, progress, checkpoint;
    bool running, priorInvincible;
    int wins,falls,round=1,startTime,lastTick,lastPoll,lastStatus,nextSpawn,finishSince,resultUntil,boostUntil,shieldUntil;
    int duration=300,segments=14; float angle=18;
    string notice="F7: START | F8: RESET | F9: CLEAR | F10: STOP", result="", lastError="";
    int noticeUntil;
    public MazLiveKOTH()
    {
        Directory.CreateDirectory(root); Directory.CreateDirectory(Path.Combine(root,"inbox"));
        // Commands from a previous launch must never replay.
        foreach(string f in Directory.GetFiles(Path.Combine(root,"inbox"),"*.cmd"))try{File.Delete(f);}catch{}
        Directory.CreateDirectory(Path.Combine(root,"acks"));
        LoadSettings(); LoadStats(); Tick+=OnTick; KeyDown+=OnKey; Aborted+=OnAbort; Interval=0;
        Log("Loaded v2.0.0-beta.1. F7 starts course in Story Mode.");
    }
    void LoadSettings()
    {
        try{
            var ini=ScriptSettings.Load(Path.Combine(root,"settings.ini"));
            angle=Math.Max(8,Math.Min(28,ini.GetValue<float>("Course","Angle",18)));
            segments=Math.Max(6,Math.Min(24,ini.GetValue<int>("Course","Segments",14)));
            duration=Math.Max(60,Math.Min(1800,ini.GetValue<int>("Course","RoundSeconds",300)));
        }catch(Exception e){Log(e.Message);}
        cosine=(float)Math.Cos(angle*Math.PI/180);sine=(float)Math.Sin(angle*Math.PI/180);
    }
    void LoadStats(){try{var a=File.ReadAllText(Path.Combine(root,"stats.txt")).Split(',');wins=int.Parse(a[0]);falls=int.Parse(a[1]);round=int.Parse(a[2]);}catch{}}
    void SaveStats(){try{File.WriteAllText(Path.Combine(root,"stats.txt"),wins+","+falls+","+round);}catch{}}
    void Log(string s){try{File.AppendAllText(Path.Combine(root,"mod.log"),DateTime.UtcNow.ToString("s")+" "+s+Environment.NewLine);}catch{}}
    void Notify(string s){notice=s;noticeUntil=Game.GameTime+5000;}
    Vector3 Point(float d,float x=0,float above=0){return origin+new Vector3(x,d*cosine,d*sine+above);}
    float Distance(Vector3 p){Vector3 d=p-origin;return d.Y*cosine+d.Z*sine;}
    void OnKey(object sender,KeyEventArgs e)
    {
        try{
            if(e.KeyCode==Keys.F7){if(!running)Start();}
            if(e.KeyCode==Keys.F8&&running)ResetPlayer();
            if(e.KeyCode==Keys.F9)ClearHazards();
            if(e.KeyCode==Keys.F10)Stop();
        }catch(Exception ex){Fail(ex);}
    }
    void Fail(Exception e){
        lastError=e.Message;faulted=true;
        if(Game.GameTime-errorAt>3000||errorAt==0){errorAt=Game.GameTime;Log(e.ToString());}
        try{Stop();}catch{} Notify("ERROR - see scripts/MazLiveKOTH/mod.log");
    }
    void Start()
    {
        if(running)return;
        if(Function.Call<bool>(Hash.NETWORK_IS_SESSION_STARTED)) {Notify("STORY MODE ONLY");return;}
        Ped ped=Game.Player.Character;
        if(ped.IsDead||ped.IsInVehicle()||Function.Call<bool>(Hash.GET_MISSION_FLAG)){Notify("Exit vehicle and mission first. Stand on foot in Story Mode.");return;}
        LoadSettings();lastError="";faulted=false;boostUntil=shieldUntil=0;nextSpawn=0;
        var model=new Model("stt_prop_stunt_bblock_huge_01");
        if(!model.IsInCdImage||!model.Request(5000)){model.MarkAsNoLongerNeeded();throw new Exception("Ramp model unavailable: stt_prop_stunt_bblock_huge_01");}
        var min=new OutputArgument();var max=new OutputArgument();Function.Call(Hash.GET_MODEL_DIMENSIONS,model.Hash,min,max);
        var lo=min.GetResult<Vector3>();var hi=max.GetResult<Vector3>();
        width=hi.X-lo.X;length=hi.Y-lo.Y;
        if(width<3||length<3||length>200){model.MarkAsNoLongerNeeded();throw new Exception("Invalid ramp model dimensions");}
        float step=length-0.15f;total=segments*step;
        oldPosition=ped.Position;oldHeading=ped.Heading;priorInvincible=Function.Call<bool>(Hash.GET_PLAYER_INVINCIBLE,Game.Player.Handle);
        try{
            for(int i=0;i<segments;i++){
                // The model's top surface, rather than its pivot, defines the slope.
                Vector3 topCenter=new Vector3((lo.X+hi.X)*.5f,(lo.Y+hi.Y)*.5f,hi.Z);
                Vector3 rotated=new Vector3(topCenter.X,topCenter.Y*cosine-topCenter.Z*sine,topCenter.Y*sine+topCenter.Z*cosine);
                Vector3 pos=Point((i+.5f)*step)-rotated;
                var prop=World.CreateProp(model,pos,false,false);
                if(prop==null)throw new Exception("Could not create ramp segment "+i);
                prop.IsPersistent=true;prop.Rotation=new Vector3(angle,0,0);prop.IsPositionFrozen=true;decks.Add(prop);
                Function.Call(Hash.SET_ENTITY_LOD_DIST,prop.Handle,1200);
            }
            running=true;checkpoint=0;progress=0;result="";resultUntil=0;round=Math.Max(1,round);
            Function.Call(Hash.SET_PLAYER_INVINCIBLE,Game.Player.Handle,true);
            startTime=Game.GameTime;lastTick=Game.GameTime;finishSince=0;ResetPlayer();Notify("CLIMB TO THE TOP - hold finish for 3 seconds");
            Log("Course created: width="+width+", length="+total+", angle="+angle);
        }catch{Stop();throw;}
        finally{model.MarkAsNoLongerNeeded();}
    }
    void ResetPlayer()
    {
        if(!running)return;var ped=Game.Player.Character;
        Function.Call(Hash.CLEAR_PED_TASKS_IMMEDIATELY,ped.Handle);
        ped.Position=Point(Math.Max(4,checkpoint),0,1.1f);ped.Heading=0;ped.Velocity=Vector3.Zero;
        Function.Call(Hash.REQUEST_COLLISION_AT_COORD,ped.Position.X,ped.Position.Y,ped.Position.Z);
        finishSince=0;
    }
    void ClearHazards(){if(waitingModel!="")new Model(waitingModel).MarkAsNoLongerNeeded();waitingModel="";modelWaitSince=0;pending.Clear();foreach(var h in hazards)try{if(h.E.Exists())h.E.Delete();}catch{}hazards.Clear();}
    void Stop()
    {
        bool restore=running;running=false;boostUntil=shieldUntil=0;resultUntil=finishSince=0;result="";ClearHazards();
        if(restore){Game.Player.Character.Position=oldPosition;Game.Player.Character.Heading=oldHeading;Function.Call(Hash.SET_PLAYER_INVINCIBLE,Game.Player.Handle,priorInvincible);Function.Call(Hash.SET_RUN_SPRINT_MULTIPLIER_FOR_PLAYER,Game.Player.Handle,1f);}
        foreach(var p in decks)try{if(p.Exists())p.Delete();}catch{}decks.Clear();SaveStats();Notify("Course stopped - returned to start location");
    }
    void OnAbort(object sender,EventArgs e){Stop();}
    void OnTick(object sender,EventArgs e)
    {
        try{
            int now=Game.GameTime;
            if(running&&Function.Call<bool>(Hash.NETWORK_IS_SESSION_STARTED)){Stop();return;}
            if(now-lastPoll>=200){lastPoll=now;Poll();}
            if(now-lastAckCleanup>10000){lastAckCleanup=now;foreach(var f in Directory.EnumerateFiles(Path.Combine(root,"acks"),"*.json").Take(1000))if(DateTime.UtcNow-File.GetLastWriteTimeUtc(f)>TimeSpan.FromMinutes(2))try{File.Delete(f);}catch{}}
            if(running){
                int delta=Math.Max(0,now-lastTick);lastTick=now;
                if(Game.IsPaused){startTime+=delta;if(finishSince>0)finishSince+=delta;if(resultUntil>0)resultUntil+=delta;if(boostUntil>0)boostUntil+=delta;if(shieldUntil>0)shieldUntil+=delta;foreach(var h in hazards)h.Until+=delta;}
                else{
                    if(resultUntil>0){if(now>=resultUntil){resultUntil=0;result="";round++;checkpoint=0;progress=0;boostUntil=shieldUntil=0;startTime=now;ResetPlayer();SaveStats();}}
                    else{
                        var ped=Game.Player.Character;float d=Distance(ped.Position);progress=Math.Max(0,Math.Min(100,d/Math.Max(total-5,1)*100));
                        float under=ped.Position.Z-Point(d).Z;
                        if(ped.IsDead||under < -9||Math.Abs(ped.Position.X-origin.X)>width*.5f+7){falls++;SaveStats();ResetPlayer();Notify("FALL - back to checkpoint");}
                        if(d>=total-7&&d<=total+2&&Math.Abs(ped.Position.X-origin.X)<width*.5f&&Math.Abs(under)<5){if(finishSince==0)finishSince=now;if(now-finishSince>=3000)Finish(true);}
                        else finishSince=0;
                        if(resultUntil==0&&now-startTime>=duration*1000)Finish(false);
                        if(resultUntil==0&&now>=nextSpawn&&pending.Count>0){SpawnPending();nextSpawn=Game.GameTime+700;}
                        Function.Call(Hash.SET_RUN_SPRINT_MULTIPLIER_FOR_PLAYER,Game.Player.Handle,now<boostUntil?1.35f:1f);
                    }
                }
                if(now<shieldUntil)foreach(var h in hazards)if(h.E.Exists())Function.Call(Hash.SET_ENTITY_NO_COLLISION_ENTITY,Game.Player.Character.Handle,h.E.Handle,true);
                DrawCourse();DrawHud();Cleanup(now);
            }else Text("MAZLIVE KING OF THE HILL  |  F7 START",.03f,.04f,.42f,246,200,107);
            if(now<noticeUntil)Text(notice,.03f,.90f,.36f,255,255,255);
            if(now-lastStatus>=500){lastStatus=now;WriteStatus();}
        }catch(Exception ex){Fail(ex);}
    }
    void Finish(bool win)
    {
        if(resultUntil>0)return;
        if(win)wins++;result=win?"SUMMIT CONQUERED!":"TIME IS UP - VIEWERS WIN";resultUntil=Game.GameTime+8000;ClearHazards();SaveStats();
        Function.Call(Hash.PLAY_SOUND_FRONTEND,-1,win?"RACE_PLACED":"LOSER","HUD_AWARDS",true);
    }
    void Cleanup(int now)
    {
        for(int i=hazards.Count-1;i>=0;i--){var h=hazards[i];if(!h.E.Exists()||now>h.Until||h.E.Position.Z<origin.Z-30){if(h.E.Exists())h.E.Delete();hazards.RemoveAt(i);}}
    }
    void SpawnPending()
    {
        var p=pending.Peek();
        string name=p.Action=="tank"?"rhino":p.Action=="truck"?"phantom":p.Action=="crate"?"prop_box_wood02a_pu":"blista";
        var model=new Model(name);
        if(!model.IsInCdImage){pending.Dequeue();model.MarkAsNoLongerNeeded();Notify("Invalid model: "+name);return;}
        if(!model.IsLoaded){
            if(waitingModel!=name){waitingModel=name;modelWaitSince=Game.GameTime;}
            model.Request();
            if(Game.GameTime-modelWaitSince>5000){pending.Dequeue();model.MarkAsNoLongerNeeded();waitingModel="";Notify("Model load timed out: "+name);Log("Model load timed out "+name);}
            return;
        }
        waitingModel="";modelWaitSince=0;
        if(--p.Count<=0)pending.Dequeue();
        if(hazards.Count>=45){var first=hazards[0];if(first.E.Exists())first.E.Delete();hazards.RemoveAt(0);}
        try{
            float d=Math.Max(12,Math.Min(total-3,Distance(Game.Player.Character.Position)+32));
            float lane=Math.Max(-width*.4f,Math.Min(width*.4f,Game.Player.Character.Position.X-origin.X+(float)(rng.NextDouble()*10-5)));
            Vector3 pos=Point(d,lane,3.5f);Entity entity;
            if(p.Action=="crate"){
                var prop=World.CreateProp(model,pos,false,false);entity=prop;
            }else{
                var v=World.CreateVehicle(model,pos,180f);entity=v;
                if(v!=null){Function.Call(Hash.SET_VEHICLE_ENGINE_ON,v.Handle,true,true,false);Function.Call(Hash.SET_VEHICLE_DOORS_LOCKED,v.Handle,2);Function.Call(Hash.SET_VEHICLE_COLOURS,v.Handle,rng.Next(0,160),0);v.Rotation=new Vector3(-angle,0,180);}
            }
            if(entity==null){Notify("Spawn failed");return;}
            entity.IsPersistent=true;entity.Velocity=new Vector3(0,-14*cosine,-14*sine);
            hazards.Add(new Hazard{E=entity,Until=Game.GameTime+45000,Name=p.Name});
            Notify(p.Name+" > "+p.Action.ToUpperInvariant());
        }finally{model.MarkAsNoLongerNeeded();}
    }
    void Poll()
    {
        string inbox=Path.Combine(root,"inbox");
        foreach(var file in Directory.EnumerateFiles(inbox,"*.cmd").Take(100).OrderBy(f=>f).Take(4)){
            string id="";
            try{
                if(new FileInfo(file).Length>2048){File.Delete(file);continue;}
                var parts=File.ReadAllText(file).Split('\t');File.Delete(file);
                if(parts.Length!=7||parts[6]!="2")continue;
                id=parts[4];
                if(id.Length<1||id.Length>64||id.Any(c=>!(char.IsLetterOrDigit(c)&&c<128)&&c!='-'&&c!='_')){id="";continue;}
                if(parts[5]!=session){Ack(id,"rejected","session_mismatch");continue;}
                if(seen.Contains(id))continue; // Preserve original ACK for identical retries.
                long timestamp;int count;
                if(!long.TryParse(parts[0],out timestamp)||timestamp<UtcMs()-30000||timestamp>UtcMs()+5000){Ack(id,"rejected","expired");continue;}
                if(!int.TryParse(parts[2],out count)||count<1||count>12){Ack(id,"rejected","invalid_count");continue;}
                string user=new UTF8Encoding(false,true).GetString(Convert.FromBase64String(parts[3]));
                user=new string(user.Where(c=>!char.IsControl(c)&&c!='~'&&!char.IsSurrogate(c)).Take(32).ToArray());
                string action=parts[1];
                string[] allowed={"start","stop","clear","reset","shield","boost","checkpoint","car","truck","tank","crate"};
                if(!allowed.Contains(action)){Ack(id,"rejected","unknown_action");continue;}
                if(action!="stop"&&action!="clear"&&Function.Call<bool>(Hash.NETWORK_IS_SESSION_STARTED)){Ack(id,"rejected","story_mode_only");continue;}
                if(action!="start"&&action!="stop"&&action!="clear"&&(!running||resultUntil>0||Game.IsPaused)){Ack(id,"rejected","not_running");continue;}
                bool spawn=action=="car"||action=="truck"||action=="tank"||action=="crate";
                if(spawn&&pending.Sum(x=>x.Count)+count>100){Ack(id,"rejected","queue_full");continue;}
                seen.Add(id);seenOrder.Enqueue(id);if(seenOrder.Count>10000)seen.Remove(seenOrder.Dequeue());
                if(action=="start"){Start();if(!running){Ack(id,"rejected","start_precondition");continue;}}
                else if(action=="stop")Stop();
                else if(action=="clear")ClearHazards();
                else if(action=="reset")ResetPlayer();
                else if(action=="shield"){shieldUntil=Game.GameTime+8000;Notify(user+" > SHIELD 8 SEC");}
                else if(action=="boost"){boostUntil=Game.GameTime+10000;Notify(user+" > SPEED 10 SEC");}
                else if(action=="checkpoint"){checkpoint=Math.Max(4,Math.Min(total-20,Distance(Game.Player.Character.Position)));Notify(user+" > CHECKPOINT SAVED");}
                else pending.Enqueue(new Pending{Action=action,Name=user,Count=count});
                Ack(id,spawn?"queued":"applied",spawn?"accepted_not_yet_spawned":"ok");
            }catch(Exception ex){Log("Command: "+ex.Message);if(id!="")try{Ack(id,"failed",ex.Message);}catch{}try{File.Delete(file);}catch{}}
        }
    }
    void DrawCourse()
    {
        Vector3 top=Point(total-6,0,.2f);
        Function.Call(Hash.DRAW_MARKER,1,top.X,top.Y,top.Z,0f,0f,0f,0f,0f,0f,7f,7f,2f,90,235,190,150,false,false,2,false,0,0,false);
        if(checkpoint>0){Vector3 cp=Point(checkpoint,0,.1f);Function.Call(Hash.DRAW_MARKER,1,cp.X,cp.Y,cp.Z,0f,0f,0f,0f,0f,0f,3f,3f,.5f,246,200,107,130,false,false,2,false,0,0,false);}
        foreach(var h in hazards){if(!h.E.Exists())continue;var p=h.E.Position+new Vector3(0,0,2.5f);var x=new OutputArgument();var y=new OutputArgument();if(Function.Call<bool>(Hash.GET_SCREEN_COORD_FROM_WORLD_COORD,p.X,p.Y,p.Z,x,y))Text(h.Name,x.GetResult<float>(),y.GetResult<float>(),.28f,255,220,150);}
    }
    static void Text(string value,float x,float y,float scale,int r,int g,int b)
    {
        Function.Call(Hash.SET_TEXT_FONT,0);Function.Call(Hash.SET_TEXT_SCALE,0f,scale);Function.Call(Hash.SET_TEXT_COLOUR,r,g,b,255);Function.Call(Hash.SET_TEXT_OUTLINE);
        Function.Call(Hash.BEGIN_TEXT_COMMAND_DISPLAY_TEXT,"STRING");Function.Call(Hash.ADD_TEXT_COMPONENT_SUBSTRING_PLAYER_NAME,value);Function.Call(Hash.END_TEXT_COMMAND_DISPLAY_TEXT,x,y,0);
    }
    void DrawHud()
    {
        int remaining=Remaining();
        Function.Call(Hash.DRAW_RECT,.185f,.085f,.34f,.13f,8,15,27,210,false);
        Text("MAZLIVE  /  KING OF THE HILL",.03f,.03f,.44f,246,200,107);
        Text("ROUND "+round+"   "+(remaining/60).ToString("00")+":"+(remaining%60).ToString("00")+"   "+((int)progress)+"%",.03f,.07f,.37f,255,255,255);
        Text("WINS "+wins+"   FALLS "+falls+"   QUEUE "+pending.Sum(p=>p.Count),.03f,.105f,.31f,170,195,218);
        Text("F8 reset  |  F9 clear  |  F10 exit",.03f,.15f,.29f,190,200,215);
        if(Game.GameTime<shieldUntil)Text("SHIELD ACTIVE",.03f,.19f,.35f,100,240,210);
        if(resultUntil>0)Text(result,.32f,.40f,.65f,246,200,107);
        else if(finishSince>0)Text("HOLD FINISH: "+Math.Max(0,3-(Game.GameTime-finishSince)/1000),.35f,.4f,.55f,120,255,200);
    }
    static string Esc(string s){return new string(s.Where(c=>!char.IsControl(c)).ToArray()).Replace("\\","\\\\").Replace("\"","\\\"").Replace("\r"," ").Replace("\n"," ");}
    void WriteStatus()
    {
        try{
            string phase=faulted?"error":!running?"idle":resultUntil>0?"result":Game.IsPaused?"paused":"running";
            string json="{\"version\":\"2.0.0-beta.1\",\"protocol\":2,\"session\":\""+session+"\",\"updatedAt\":"+UtcMs()+",\"phase\":\""+phase+"\",\"progress\":"+progress.ToString("0.0",CultureInfo.InvariantCulture)+",\"wins\":"+wins+",\"falls\":"+falls+",\"round\":"+round+",\"seconds\":"+Remaining()+",\"queue\":"+pending.Sum(p=>p.Count)+",\"objects\":"+hazards.Count+",\"result\":\""+Esc(result)+"\",\"error\":\""+Esc(lastError)+"\"}";
            Atomic(Path.Combine(root,"status.json"),json);
        }catch{}
    }
}
