using Ferry.Api.Embark;

namespace Ferry.Api.Controllers;

[Route("embark")]
public class EmbarkController : ControllerBase
{
    private readonly IEmbarkPipeline _pipeline;
    private readonly IToggleService _toggles;

    public EmbarkController(IEmbarkPipeline pipeline, IToggleService toggles)
    {
        _pipeline = pipeline;
        _toggles = toggles;
    }

    [HttpPost("{ticket}")]
    public async Task<IActionResult> Board(int ticket)
    {
        if (ticket < 0) return BadRequest();
        var done = await _pipeline.ProcessAsync(new EmbarkRequest { Ticket = ticket });
        return done is not null ? Ok(done) : Conflict();
    }

    [HttpPost("{ticket}/fast")]
    public async Task<IActionResult> Fast(int ticket)
    {
        if (_toggles.IsToggleEnabled(Toggles.FastEmbark))
        {
            var done = await _pipeline.ProcessAsync(new EmbarkRequest { Ticket = ticket });
            return done is not null ? Ok(done) : Conflict();
        }

        return NotFound();
    }
}
