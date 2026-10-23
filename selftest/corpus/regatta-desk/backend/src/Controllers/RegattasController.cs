using Microsoft.AspNetCore.Mvc;

namespace Regatta.Api.Controllers
{
    [ApiController]
    [Route("regattas/v1")]
    public class RegattasController : ControllerBase
    {
        [HttpGet("{id}")]
        public IActionResult Get(string id)
        {
            return Ok();
        }

        [HttpGet("{id}/entries")]
        public IActionResult Entries(string id)
        {
            return Ok();
        }

        [HttpPost("{id}/protests")]
        public IActionResult Protest(string id)
        {
            return Ok();
        }

        [HttpGet("results")]
        public IActionResult Results()
        {
            return Ok();
        }

        [HttpGet("{id}/standings")]
        public IActionResult Standings(string id)
        {
            return Ok();
        }
    }
}
