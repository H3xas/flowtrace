using System.Threading.Tasks;
using Bakery.Api.Models;
using Bakery.Api.Pipelines;
using Bakery.Api.Services;
using Microsoft.AspNetCore.Mvc;

namespace Bakery.Api.Controllers
{
    [ApiController]
    [Route("bakery/v1/proofs")]
    public class ProofsController : ControllerBase
    {
        private readonly IProofService _service;
        private readonly IProofPipeline _proofs;
        private readonly ILooseProofPipeline _looseProofs;

        public ProofsController(IProofService service, IProofPipeline proofs, ILooseProofPipeline looseProofs)
        {
            _service = service;
            _proofs = proofs;
            _looseProofs = looseProofs;
        }

        [HttpPost]
        public async Task<IActionResult> Proof([FromBody] DoughRequest request)
        {
            try
            {
                var proofed = await _service.ProofAsync(request);
                return proofed is not null ? Ok(proofed) : BadRequest();
            }
            catch (OverProofedException)
            {
                return Conflict();
            }
        }

        [HttpPost("quick")]
        public async Task<IActionResult> Quick([FromBody] DoughRequest request)
        {
            try
            {
                var proofed = await _proofs.ProcessAsync(new Dough(request));
                return proofed is not null ? Ok(proofed) : BadRequest();
            }
            catch (OverProofedException)
            {
                return Conflict();
            }
        }

        [HttpPost("loose")]
        public async Task<IActionResult> Loose([FromBody] DoughRequest request)
        {
            try
            {
                var proofed = await _looseProofs.ProcessAsync(new Dough(request));
                return proofed is not null ? Ok(proofed) : BadRequest();
            }
            catch (OverProofedException)
            {
                return Conflict();
            }
        }
    }
}
