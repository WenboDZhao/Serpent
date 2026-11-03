-- Exact pixel/cel operations only. Never save the original document.
local function loadJson(filename)
  local file = assert(io.open(filename, 'rb')); local data = file:read('*a'); file:close()
  return json.decode(data)
end
local function saveJson(filename, value)
  local file = assert(io.open(filename, 'wb')); file:write(json.encode(value)); file:close()
end
local mode = assert(app.params.mode)
local out = assert(app.params.out)
local source = app.sprite
if mode == 'inspect' then
  assert(source)
  local layers = {}
  local function visit(items, prefix)
    for i, layer in ipairs(items) do
      local layerPath = {}; for _, part in ipairs(prefix) do table.insert(layerPath, part) end
      table.insert(layerPath, i)
      local cels = {}
      for _, cel in ipairs(layer.cels) do
        table.insert(cels, {frame=cel.frame.frameNumber,x=cel.position.x,y=cel.position.y,width=cel.image.width,height=cel.image.height})
      end
      table.insert(layers, {path=layerPath,name=layer.name,visible=layer.isVisible,isGroup=layer.isGroup,cels=cels})
      if layer.isGroup then visit(layer.layers, layerPath) end
    end
  end
  visit(source.layers, {})
  local durations, tags = {}, {}
  for _, frame in ipairs(source.frames) do table.insert(durations, math.floor(frame.duration*1000+0.5)) end
  for _, tag in ipairs(source.tags) do table.insert(tags, {name=tag.name,from=tag.fromFrame.frameNumber,to=tag.toFrame.frameNumber}) end
  saveJson(out, {width=source.width,height=source.height,layers=layers,durationsMs=durations,tags=tags})
elseif mode == 'build' then
  local manifest = loadJson(assert(app.params.manifest))
  local sprite = Sprite(manifest.canvas.width, manifest.canvas.height, ColorMode.RGB)
  local layers = {sprite.layers[1]}
  for i, spec in ipairs(manifest.layers) do
    if i>1 then layers[i]=sprite:newLayer() end
    layers[i].name=spec.name
  end
  for i, frame in ipairs(manifest.frames) do
    if i>1 then sprite:newEmptyFrame(i) end
    sprite.frames[i].duration=frame.durationMs/1000
    for _, cel in ipairs(frame.cels) do
      -- A numbered PNG is one explicit cel, not an implicitly expanded file sequence.
      local imageSprite = assert(Sprite{fromFile=cel.path,oneFrame=true})
      local flat = Image(imageSprite.width,imageSprite.height,ColorMode.RGB)
      flat:drawSprite(imageSprite,1)
      local image=flat
      if cel.rect then
        local rect=cel.rect
        assert(rect.x>=0 and rect.y>=0 and rect.x+rect.width<=flat.width and rect.y+rect.height<=flat.height,'crop outside PNG')
        image=Image(flat,Rectangle(rect.x,rect.y,rect.width,rect.height))
      end
      local position=cel.position or {x=0,y=0}
      assert(position.x>=0 and position.y>=0 and position.x+image.width<=sprite.width and position.y+image.height<=sprite.height,'cel outside canvas')
      sprite:newCel(layers[cel.layer],i,image,Point(position.x,position.y))
      imageSprite:close()
    end
  end
  for _, action in ipairs(manifest.actions or {}) do
    local tag=sprite:newTag(action.from,action.to);tag.name=action.name
  end
  sprite:saveCopyAs(out)
  sprite:close()
elseif mode == 'render' then
  assert(source)
  local recipe=loadJson(assert(app.params.recipe))
  local crop=recipe.crop
  assert(crop.x+crop.width<=source.width and crop.y+crop.height<=source.height,'crop outside source')
  local scale,padding,columns=recipe.layout.scale,recipe.layout.padding,recipe.layout.columns
  local cellW,cellH=crop.width*scale,crop.height*scale
  local gap=padding*scale
  local rows=math.ceil(#recipe.combinations/columns)
  local board=Sprite(columns*cellW+(columns+1)*gap,rows*cellH+(rows+1)*gap,ColorMode.RGB)
  local frames,durations={},{}
  local elapsed,previous=0,0
  for _, action in ipairs(recipe.actions) do
    for i,frame in ipairs(action.frames) do
      assert(source.frames[frame],'frame outside source')
      table.insert(frames,frame)
      elapsed=elapsed+action.durationsMs[i]
      local target=math.floor(elapsed/10+0.5)*10
      table.insert(durations,target-previous);previous=target
    end
  end
  local visibility={}
  local function remember(layers)
    for _, layer in ipairs(layers) do
      visibility[layer]=layer.isVisible
      if layer.isGroup then remember(layer.layers) end
    end
  end
  remember(source.layers)
  local function restore() for layer,visible in pairs(visibility) do layer.isVisible=visible end end
  local function choose(combination)
    restore()
    if not combination.layers then return end
    for layer,_ in pairs(visibility) do layer.isVisible=false end
    for _, parts in ipairs(combination.layers) do
      local layers=source.layers
      for i,index in ipairs(parts) do
        local layer=assert(layers[index],'layer path outside source')
        layer.isVisible=true
        if i<#parts then assert(layer.isGroup,'layer path is not group');layers=layer.layers end
      end
    end
  end
  for i,sourceFrame in ipairs(frames) do
    local image=Image(board.width,board.height,ColorMode.RGB)
    for j,combination in ipairs(recipe.combinations) do
      choose(combination)
      local flat=Image(source.width,source.height,ColorMode.RGB);flat:drawSprite(source,sourceFrame)
      local clipped=Image(flat,Rectangle(crop.x,crop.y,crop.width,crop.height))
      local originX=gap+((j-1)%columns)*(cellW+gap)
      local originY=gap+math.floor((j-1)/columns)*(cellH+gap)
      for pixel in clipped:pixels() do
        local value=pixel()
        if app.pixelColor.rgbaA(value)>0 then
          for dy=0,scale-1 do for dx=0,scale-1 do image:drawPixel(originX+pixel.x*scale+dx,originY+pixel.y*scale+dy,value) end end
        end
      end
    end
    if i>1 then board:newEmptyFrame(i) end
    board.frames[i].duration=durations[i]/1000
    board:newCel(board.layers[1],i,image,Point(0,0))
  end
  restore()
  board:saveCopyAs(out)
  saveJson(assert(app.params.record), {frames=frames,durationsMs=durations,width=board.width,height=board.height})
  board:close()
else error('Unknown mode: '..mode) end
