import{b as x,e as E,g as N,i as h,j as L}from"./chunk-5S4UDAQ6.js";import{a as s,b as w,ca as m,d as v,da as b,i as q,j as S,l as k,r as y}from"./chunk-RPSB52CI.js";import"./chunk-TXSQ2J5N.js";import{c as u}from"./chunk-FBVUHKE5.js";u();u();var T=o=>{document.querySelector(o+" .md img")&&(L("fancybox"),L("justifiedGallery"),h("jquery",()=>{h("justifiedGallery",()=>{h("fancybox",()=>{let e=jQuery.noConflict();s.each(o+" p.gallery",t=>{let a=document.createElement("div");a.className="gallery",a.setAttribute("data-height",String(t.getAttribute("data-height")||220)),a.innerHTML=t.innerHTML.replace(/<br>/g,""),t.parentNode.insertBefore(a,t),t.remove()}),s.each(o+" .md img:not(.emoji):not(.vemoji)",t=>{let a=e(t),i=a.attr("data-src")||a.attr("src"),c=a.wrap('<a class="fancybox" href="'+i+'" itemscope itemtype="https://schema.org/ImageObject" itemprop="url"></a>').parent("a"),n,l="image-info";if(a.is("a img")||(a.data("safe-src",i),a.is(".gallery img")?l="jg-caption":c.attr("data-fancybox","default").attr("rel","default")),n=t.getAttribute("title")){c.attr("data-caption",n);let p=document.createElement("span"),r=document.createTextNode(n);p.appendChild(r),p.addClass(l),w(t,p)}}),s.each(o+" div.gallery",(t,a)=>{e(t).justifiedGallery({rowHeight:e(t).data("height")||120,rel:"gallery-"+a}).on("jg.complete",function(){e(this).find("a").each((i,c)=>{c.setAttribute("data-fancybox","gallery-"+a)})})}),e.fancybox.defaults.hash=!1,e(o+" .fancybox").fancybox({loop:!0,helpers:{overlay:{locked:!1}}})},window.jQuery)})}))};var J=()=>{if(!document.querySelector(".md"))return;T(".post.block"),document.querySelector(".post.block").oncopy=e=>{if(x(LOCAL.copyright),LOCAL.nocopy){e.preventDefault();return}let t=document.getElementById("copyright");if(window.getSelection().toString().length>k.experiments.copyrightLength&&t){e.preventDefault();let a="# "+t.querySelector(".author").innerText,i="# "+t.querySelector(".link").innerText,c="# "+t.querySelector(".license").innerText,n=a+"<br>"+i+"<br>"+c+"<br><br>"+window.getSelection().toString().replace(/\r\n/g,"<br>"),l=a+`
`+i+`
`+c+`

`+window.getSelection().toString().replace(/\r\n/g,`
`);if(e.clipboardData)e.clipboardData.setData("text/html",n),e.clipboardData.setData("text/plain",l);else if(window.clipboardData)return window.clipboardData.setData("text",l)}},s.each("li ruby",e=>{let t=e.parentNode;e.parentNode.tagName!=="LI"&&(t=e.parentNode.parentNode),t.addClass("ruby")}),s.each("ol[start]",e=>{e.style.counterReset="counter "+parseInt(e.getAttribute("start")-1)}),s.each(".md table",e=>{v(e,{className:"table-container"})}),s.each(".highlight > .table-container",e=>{e.className="code-container"}),s.each("figure.highlight",e=>{let t=e.querySelector(".code-container"),a=e.querySelector("figcaption");e.insertAdjacentHTML("beforeend",'<div class="operation"><span class="breakline-btn"><i class="ic i-align-left"></i></span><span class="copy-btn"><i class="ic i-clipboard"></i></span><span class="fullscreen-btn"><i class="ic i-expand"></i></span></div>');let i=e.querySelector(".copy-btn");LOCAL.nocopy?i.remove():(i.addEventListener("click",r=>{let d=r.currentTarget,f="",C="";t.find("pre").forEach(g=>{C+=f+g.innerText,f=`
`}),E(C,g=>{d.querySelector(".ic").className=g?"ic i-check":"ic i-times",d.blur(),x(LOCAL.copyright)})},{passive:!0}),i.addEventListener("mouseleave",r=>{setTimeout(()=>{r.target.querySelector(".ic").className="ic i-clipboard"},1e3)})),e.querySelector(".breakline-btn").addEventListener("click",r=>{let d=r.currentTarget;e.hasClass("breakline")?(e.removeClass("breakline"),d.querySelector(".ic").className="ic i-align-left"):(e.addClass("breakline"),d.querySelector(".ic").className="ic i-align-justify")});let n=e.querySelector(".fullscreen-btn"),l=()=>{e.removeClass("fullscreen"),e.scrollTop=0,y.removeClass("fullscreen"),n.querySelector(".ic").className="ic i-expand"},p=()=>{if(e.hasClass("fullscreen")){if(l(),t&&t.find("tr").length>15){let r=t.querySelector(".show-btn");t.style.maxHeight="300px",r.removeClass("open")}b(e)}else if(e.addClass("fullscreen"),y.addClass("fullscreen"),n.querySelector(".ic").className="ic i-compress",t&&t.find("tr").length>15){let r=t.querySelector(".show-btn");t.style.maxHeight="",r.addClass("open")}};if(n.addEventListener("click",p),a&&a.addEventListener("click",p),t&&t.find("tr").length>15){t.style.maxHeight="300px",t.insertAdjacentHTML("beforeend",'<div class="show-btn"><i class="ic i-angle-down"></i></div>');let r=t.querySelector(".show-btn"),d=()=>{t.style.maxHeight="300px",r.removeClass("open")},f=()=>{t.style.maxHeight="",r.addClass("open")};r.addEventListener("click",()=>{r.hasClass("open")?(l(),d(),b(t)):f()})}}),s.each("pre.mermaid > svg",e=>{let t=e;t.style.maxWidth=""}),s.each(".reward button",e=>{e.addEventListener("click",t=>{t.preventDefault();let a=document.getElementById("qr");q(a)==="inline-flex"?m(a,0):m(a,1,()=>{S(a,"inline-flex")})})}),s.each(".quiz > ul.options li",e=>{e.addEventListener("click",()=>{e.hasClass("correct")?(e.toggleClass("right"),e.parentNode.parentNode.addClass("show")):e.toggleClass("wrong")})}),s.each(".quiz > p",e=>{e.addEventListener("click",()=>{e.parentNode.toggleClass("show")})}),s.each(".quiz > p:first-child",e=>{let t=e.parentNode,a="choice";(t.hasClass("true")||t.hasClass("false"))&&(a="true_false"),t.hasClass("multi")&&(a="multiple"),t.hasClass("fill")&&(a="gap_fill"),t.hasClass("essay")&&(a="essay"),e.setAttribute("data-type",LOCAL.quiz[a])}),s.each(".quiz .mistake",e=>{e.setAttribute("data-type",LOCAL.quiz.mistake)}),s.each("div.tags a",e=>{e.className=["primary","success","info","warning","danger"][Math.floor(Math.random()*5)]}),s.each(".md div.player",e=>{N(e,{type:e.getAttribute("data-type"),mode:"order",btns:[]}).player.load(JSON.parse(e.getAttribute("data-src"))).fetch()});let o=document.querySelectorAll(".show-btn .i-angle-down");if(o.length){let e=new IntersectionObserver(t=>{t.forEach(a=>{a.isIntersecting?o.forEach(i=>{i.classList.remove("stop-animation")}):o.forEach(i=>{i.classList.add("stop-animation")})})},{root:null,threshold:.5});o.forEach(t=>{e.observe(t)})}};export{J as postBeauty};
/*! For license information please see post-RXO33MYC.js.LEGAL.txt */
