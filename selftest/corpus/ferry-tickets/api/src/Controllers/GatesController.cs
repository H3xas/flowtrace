using Ferry.Api.Gates;

namespace Ferry.Api.Controllers;

[Route("gates")]
public class GatesController : ControllerBase
{
    private readonly GateRules _rules;

    public GatesController(GateRules rules)
    {
        _rules = rules;
    }

    [HttpGet("{id}/open")]
    public IActionResult Open(int id, bool allowed)
    {
        return allowed ? Ok(_rules.Rank(id)) : Forbid();
    }

    [HttpGet("{id}/status")]
    public IActionResult Status(int id, GateStatus status)
    {
        return status == GateStatus.Open ? Ok(id) : Forbid();
    }
}
