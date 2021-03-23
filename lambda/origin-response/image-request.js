'use strict';
const HostCustomOrigin = 'https://youtravel.me';

module.exports = class ImageRequest {

    constructor(request) {
        this.request = {};
        this.transformOptions = {};
        this.originUri = '';
        this.format = 'original';
        this.transformDefaults = {
            w: 2200,
            h: null
        };
        this.uriExp = /(\/(webp|original))?\/(tr:.+?\/)?(.*)/;

        this._init(request);
    }

    getRequestUri(){
        return this.request.uri;
    }
    getOriginUri(){
        return this.originUri
    }

    getOriginFullUrl(){
        return `${HostCustomOrigin}${this.originUri}`;
    }

    getTransformOptions(){
        return this.transformOptions;
    }

    isAllowWebp(){
        return this.format === 'webp';
    }

    parseTransformOptions(transformString){
        if(transformString === false){
            return false;
        }
        let result = transformString.match(/tr:(.*)/);
        let transformOptions = {};
        if(typeof result != "undefined" && result != null && !!result[1]){
            let options = result[1].split(',');
            for(let i in options){
                let item = options[i].split('-');
                if(['w', 'h'].includes(item[0])){
                    item[1] = parseInt(item[1]);
                }
                transformOptions[item[0]] = item[1];
            }
            return {...this.transformDefaults, ...transformOptions};
        }
        return false;
    }

    _init(request){
        this.request = request;
        let result = this.request.uri.match(this.uriExp);

        if(typeof result != "undefined" && result != null){
            this.format = result[2];
            if(typeof result[3] != "undefined"){
                this.transformOptions = this.parseTransformOptions(result[3].replace(/\/$/, ""));
            }
            this.originUri = '/' + result[4];
        }else{
            this.originUri = this.request.uri;
            this.transformOptions = this.transformDefaults;
        }
    }

}

