import AppKit
let size = 1024
let bitmap = NSBitmapImageRep(bitmapDataPlanes:nil,pixelsWide:size,pixelsHigh:size,bitsPerSample:8,samplesPerPixel:4,hasAlpha:true,isPlanar:false,colorSpaceName:.deviceRGB,bytesPerRow:0,bitsPerPixel:0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep:bitmap)
NSColor(calibratedRed:0.953,green:0.941,blue:0.914,alpha:1).setFill()
NSBezierPath(roundedRect:NSRect(x:42,y:42,width:940,height:940),xRadius:204,yRadius:204).fill()
let fold=NSBezierPath();fold.move(to:NSPoint(x:295,y:315));fold.line(to:NSPoint(x:593,y:432));fold.line(to:NSPoint(x:593,y:787));fold.line(to:NSPoint(x:295,y:670));fold.close()
NSColor(calibratedRed:0.471,green:0.239,blue:0.286,alpha:1).setFill();fold.fill()
let edge=NSBezierPath();edge.move(to:NSPoint(x:528,y:274));edge.line(to:NSPoint(x:729,y:352));edge.line(to:NSPoint(x:729,y:636));edge.lineWidth=44;edge.lineJoinStyle = .round
NSColor(calibratedRed:0.545,green:0.510,blue:0.471,alpha:1).setStroke();edge.stroke()
NSGraphicsContext.restoreGraphicsState()
try bitmap.representation(using:.png,properties:[:])!.write(to:URL(fileURLWithPath:CommandLine.arguments[1]))
