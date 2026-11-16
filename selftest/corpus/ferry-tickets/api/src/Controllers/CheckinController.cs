using Ferry.Api.Checkin;

namespace Ferry.Api.Controllers;

[Route("checkin")]
public class CheckinController : ControllerBase
{
    private readonly ICheckinPipeline _pipeline;

    public CheckinController(ICheckinPipeline pipeline)
    {
        _pipeline = pipeline;
    }

    [HttpPost("{ticket}")]
    public async Task<IActionResult> Start(int ticket)
    {
        var done = await _pipeline.ProcessAsync(new CheckinRequest { Ticket = ticket });
        return done is not null ? Ok(done) : BadRequest();
    }

    [HttpPost("{ticket}/caught")]
    public async Task<IActionResult> Caught(int ticket)
    {
        try
        {
            var done = await _pipeline.ProcessAsync(new CheckinRequest { Ticket = ticket });
            return done is not null ? Ok(done) : BadRequest();
        }
        catch (TicketBadRequestException)
        {
            return Conflict();
        }
    }
}
