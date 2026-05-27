export {};

type VNode = { tag: string };

class Foo {
  label = "default";
}

class CastFixture {
  imageElement: HTMLImageElement = new HTMLImageElement();

  update() {
    let imgScr: string = <string>this.imageElement;
    this.imageElement = new HTMLImageElement();
    (<HTMLImageElement>this.imageElement).src = imgScr;
    return imgScr;
  }
}

let emptyArray = <VNode[]>[];
var x: string = "";
var y: Foo = null;

void [CastFixture, emptyArray, x, y];
