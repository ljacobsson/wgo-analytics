(()=>{function o(e){let t=e.items.reduce((r,c)=>r+c.price,0);if(t>100)throw new Error("too expensive");return t}function n(e){return o(e)}n({items:[{price:500}]});})();
//# sourceMappingURL=app-abc123.js.map
