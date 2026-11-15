using Ferry.Api.Boarding;

namespace Ferry.Api.Controllers;

[Route("boarding")]
public class BoardingController : ControllerBase
{
    private readonly IBoardingService _boarding;

    public BoardingController(IBoardingService boarding)
    {
        _boarding = boarding;
    }

    [HttpPost("{ticket}/approve")]
    public async Task<IActionResult> Approve(int ticket)
    {
        var approved = await _boarding.ApproveAsync(ticket);
        if (approved) return Ok(true);
        return Forbid();
    }

    [HttpGet("{ticket}/pass")]
    public async Task<IActionResult> Pass(int ticket)
    {
        var pass = await _boarding.FindPassAsync(ticket);
        if (pass != null)
        {
            return Ok(pass);
        }
        return NotFound();
    }

    [HttpGet("{ticket}/stub")]
    public async Task<IActionResult> Stub(int ticket)
    {
        var pass = await _boarding.FindPassAsync(ticket);
        if (pass is not null) return Ok(pass);
        return StatusCode(410);
    }

    [HttpPost("{ticket}/late")]
    public async Task<IActionResult> Late(int ticket)
    {
        var approved = await _boarding.ApproveAsync(ticket);
        if (approved) return Ok(true);
        ticket++;
        return Forbid();
    }

    [HttpPost("{ticket}/logged")]
    public async Task<IActionResult> Logged(int ticket)
    {
        var approved = await _boarding.ApproveAsync(ticket);
        if (approved)
        {
            ticket++;
            return Ok(true);
        }
        return Forbid();
    }

    [HttpPost("{ticket}/shaped")]
    public async Task<IActionResult> Shaped(int ticket)
    {
        var approved = await _boarding.ApproveAsync(ticket);
        if (approved) return Ok(true);
        return Refusal(ticket);
    }

    [HttpPost("{ticket}/either")]
    public async Task<IActionResult> Either(int ticket)
    {
        var approved = await _boarding.ApproveAsync(ticket);
        if (approved) return Ok(true);
        else return Forbid();
    }

    private IActionResult Refusal(int ticket) => Forbid();
}
