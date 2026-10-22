/** Count observed responses by explicit SDK identity, never by overlapping collection sizes. */
export class ModelResponseCounter {
  private messages=new Set<string>();
  private requests=new Set<string>();
  private requestsWithMessage=new Set<string>();
  private messageRequests=new Map<string,Set<string>>();
  private namedStream=false;
  private namedAssistant=false;
  private streamStarted=false;
  private unidentified=0;
  private id(value:unknown){return typeof value==='string'&&value.length>0?value:null;}
  retry(){this.streamStarted=false;}
  streamStart(messageId:unknown){
    this.streamStarted=true;
    const id=this.id(messageId);
    if(id){this.messages.add(id);this.namedStream=true;}else this.unidentified++;
  }
  streamActivity(){
    if(!this.streamStarted){this.streamStarted=true;this.unidentified++;}
  }
  assistant(requestId:unknown,messageId:unknown){
    const request=this.id(requestId),message=this.id(messageId);
    if(!request&&!message){this.unidentified++;return;}
    this.namedAssistant=true;
    if(request)this.requests.add(request);
    if(message)this.messages.add(message);
    if(request&&message){
      this.requestsWithMessage.add(request);
      const links=this.messageRequests.get(message)??new Set<string>();links.add(request);this.messageRequests.set(message,links);
    }
  }
  snapshot(){
    const unlinkedMessages=[...this.messages].filter(id=>!this.messageRequests.has(id)).length;
    const requestOnly=this.requests.size-this.requestsWithMessage.size;
    const overlapUnknown=Math.min(unlinkedMessages,requestOnly);
    const conflicting=[...this.messageRequests.values()].some(ids=>ids.size>1);
    // A request-only ID may describe an unlinked stream. Retain a lower bound, not a guessed union.
    const known=this.requests.size+unlinkedMessages-overlapUnknown;
    const incomplete=this.unidentified>0||overlapUnknown>0||conflicting;
    return{model_requests:incomplete?null:known||null,model_requests_known:known,
      unidentified_response_events:this.unidentified,
      model_request_count_source:incomplete?'partial response IDs; unidentified or ambiguous response links':
        this.namedStream&&this.namedAssistant?'linked stream/assistant request and message IDs':
        this.namedStream?'unique stream message IDs':this.namedAssistant?'unique assistant request/message IDs':'unavailable'};
  }
}
